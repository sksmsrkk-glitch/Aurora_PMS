import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  closePmsDatabase,
  getPmsDatabase,
  scopePmsDatabase,
} from "../db/pms-database.ts";
import { ROLE_ACCESS_TEMPLATES } from "../app/access-control.ts";
import { commit, dryRun, rollback } from "../app/api/platform/imports/route.ts";
import { getAvailability } from "../app/api/booking/service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "",
  skip = !databaseUrl;
const client = () =>
  postgres(databaseUrl, {
    max: 4,
    prepare: false,
    ssl: false,
    idle_timeout: 2,
  });

test(
  "control plane schema and all new tenant tables enforce RLS",
  { skip },
  async () => {
    const sql = client();
    try {
      const [catalog] =
        await sql`SELECT (SELECT COUNT(*)::int FROM pg_policies WHERE schemaname='public' AND policyname='aurora_property_isolation') policy_count,to_regclass('public.organizations')::text organizations,to_regclass('public.worker_jobs')::text worker_jobs,to_regclass('public.support_access_grants')::text support_grants`;
      assert.ok(catalog.policy_count >= 66);
      assert.equal(catalog.organizations, "organizations");
      assert.equal(catalog.worker_jobs, "worker_jobs");
      assert.equal(catalog.support_grants, "support_access_grants");
      const forced =
        await sql`SELECT relname,relforcerowsecurity FROM pg_class WHERE relname IN ('property_domains','support_access_grants','data_import_jobs','worker_jobs','backup_runs') ORDER BY relname`;
      assert.equal(forced.length, 5);
      assert.ok(forced.every((row) => row.relforcerowsecurity));
    } finally {
      await sql.end({ timeout: 2 });
    }
  },
);

test(
  "property provisioning is atomic, idempotent and hostname-resolvable",
  { skip },
  async () => {
    const sql = client(),
      userId = "11111111-1111-4111-8111-111111111111",
      email = "saas-owner@example.com",
      suffix = crypto.randomUUID().slice(0, 8),
      organizationId = `org-saas-${suffix}`,
      slug = `saas-test-${suffix}`;
    try {
      await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'SaaS Test',${slug},'ACTIVE')`;
      await sql`INSERT INTO organization_memberships(id,organization_id,auth_user_id,email,display_name,role,active) VALUES (${`org-member-${suffix}`},${organizationId},${userId}::uuid,${email},'SaaS Owner','OWNER',true)`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        input = {
          propertyId: `prop-saas-${suffix}`,
          organizationId,
          authUserId: userId,
          actorEmail: email,
          actorName: "SaaS Owner",
          name: "SaaS Test Hotel",
          code: `S${suffix.slice(0, 6)}`,
          slug,
          timezone: "Asia/Seoul",
          currency: "KRW",
          businessDate: "2026-07-19",
          planCode: "STANDARD",
          hostname: `${slug}.example.com`,
          workspacePermissions:
            ROLE_ACCESS_TEMPLATES.PROPERTY_ADMIN.permissions,
        };
      const first = await db.provisionProperty(input),
        second = await db.provisionProperty(input);
      assert.deepEqual(second, first);
      assert.equal(first.propertyId, input.propertyId);
      assert.deepEqual(await db.resolvePublicProperty(input.hostname), {
        property_id: input.propertyId,
        property_slug: input.slug,
        organization_id: input.organizationId,
      });
      const [counts] =
        await sql`SELECT (SELECT COUNT(*)::int FROM property_entitlements WHERE property_id=${input.propertyId}) entitlements,(SELECT COUNT(*)::int FROM rate_plans WHERE property_id=${input.propertyId}) plans,(SELECT COUNT(*)::int FROM role_assignments WHERE property_id=${input.propertyId}) admins`;
      assert.equal(counts.entitlements, 10);
      assert.equal(counts.plans, 3);
      assert.equal(counts.admins, 1);
      await sql`UPDATE property_subscriptions SET room_limit=1,user_limit=1 WHERE property_id=${input.propertyId}`;
      const roomTypeId = `rt-limit-${suffix}`;
      await sql`INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (${roomTypeId},${input.propertyId},'LIMIT','Limit Room',100000,2,'Limit test',true)`;
      const scoped = scopePmsDatabase(db, input.propertyId),
        roomInsert = (id, number) =>
          scoped
            .prepare(
              "INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?,pms_current_property_id(),?, ?,1,'VACANT','CLEAN','[]'::jsonb,true,1)",
            )
            .bind(id, roomTypeId, number)
            .run();
      const roomResults = await Promise.allSettled([
        roomInsert(`room-limit-a-${suffix}`, "L01"),
        roomInsert(`room-limit-b-${suffix}`, "L02"),
      ]);
      assert.equal(
        roomResults.filter((result) => result.status === "fulfilled").length,
        1,
        "concurrent inserts must not exceed the room limit",
      );
      await assert.rejects(
        scoped
          .prepare(
            "INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,must_change_password,version) VALUES (?,pms_current_property_id(),?,'VIEWER',true,clock_timestamp(),'Limit User',?::jsonb,false,false,1)",
          )
          .bind(
            `role-limit-${suffix}`,
            `limit-${suffix}@example.com`,
            ROLE_ACCESS_TEMPLATES.VIEWER.permissions,
          )
          .run(),
        /SUBSCRIPTION_USER_LIMIT_EXCEEDED/u,
      );
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "support access is JIT, entitlement-gated, auditable and immediately revocable",
  { skip },
  async () => {
    const sql = client(),
      operatorId = "22222222-2222-4222-8222-222222222222",
      email = "support@example.com",
      grantId = `grant-${crypto.randomUUID()}`;
    try {
      await sql`INSERT INTO platform_operators(auth_user_id,email,display_name,role,active) VALUES (${operatorId}::uuid,${email},'Support Engineer','SUPPORT',true) ON CONFLICT(auth_user_id) DO UPDATE SET active=true`;
      await sql`INSERT INTO support_access_grants(id,property_id,operator_user_id,operator_email,access_mode,workspace_permissions,pii_mode,reason,ticket_reference,starts_at,expires_at,approved_by) VALUES (${grantId},'prop-seoul',${operatorId}::uuid,${email},'READ',${sql.json(ROLE_ACCESS_TEMPLATES.VIEWER.permissions)},'MASKED','Customer approved integration test','TEST-001',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '30 minutes','owner@example.com')`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        assignments = await db.findActiveSupportAssignments(operatorId, email);
      assert.ok(assignments.some((item) => item.grant_id === grantId));
      const requestId = `req-${crypto.randomUUID()}`;
      assert.equal(
        await db.recordSupportAccess({
          grantId,
          authUserId: operatorId,
          actorEmail: email,
          write: false,
          requestId,
          action: "snapshot",
        }),
        true,
      );
      assert.equal(
        await db.recordSupportAccess({
          grantId,
          authUserId: operatorId,
          actorEmail: email,
          write: true,
          requestId: `req-${crypto.randomUUID()}`,
          action: "mutation",
        }),
        false,
        "READ support grants must never record or execute a write",
      );
      const [audit] =
        await sql`SELECT (SELECT COUNT(*)::int FROM support_sessions WHERE grant_id=${grantId}) sessions,(SELECT COUNT(*)::int FROM audit_logs WHERE entity_type='support_session' AND after_json->>'requestId'=${requestId}) audits`;
      assert.equal(audit.sessions, 1);
      assert.equal(audit.audits, 1);
      await sql`UPDATE support_access_grants SET revoked_at=clock_timestamp(),revoked_by='test' WHERE id=${grantId}`;
      assert.equal(
        await db.recordSupportAccess({
          grantId,
          authUserId: operatorId,
          actorEmail: email,
          write: false,
          requestId: `req-${crypto.randomUUID()}`,
          action: "snapshot",
        }),
        false,
      );
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "public booking is disabled by the tenant entitlement",
  { skip },
  async () => {
    const sql = client(),
      suffix = crypto.randomUUID().slice(0, 8),
      organizationId = `org-gate-${suffix}`,
      propertyId = `prop-gate-${suffix}`;
    try {
      await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Gate Test',${`gate-${suffix}`},'ACTIVE')`;
      await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug,status,onboarding_status,plan_code,cell_key,settings) VALUES (${propertyId},'Gate Hotel',${`G${suffix.slice(0, 6)}`},'Asia/Seoul','KRW','2026-07-19',${organizationId},${`gate-hotel-${suffix}`},'ACTIVE','LIVE','STANDARD','primary','{}'::jsonb)`;
      await sql`INSERT INTO property_subscriptions(id,property_id,plan_code,status,current_period_start,current_period_end) VALUES (${`sub-${suffix}`},${propertyId},'STANDARD','ACTIVE','2026-07-19','2026-08-18')`;
      await sql`INSERT INTO property_entitlements(property_id,feature_key,enabled,limits,updated_by) VALUES (${propertyId},'DIRECT_BOOKING',false,'{}'::jsonb,'integration-test')`;
      await assert.rejects(
        getAvailability(
          {
            arrival: "2026-08-01",
            departure: "2026-08-02",
            adults: 2,
            children: 0,
          },
          propertyId,
        ),
        (error) =>
          error?.code === "DIRECT_BOOKING_DISABLED" && error?.status === 404,
      );
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "concurrent worker claims deliver each job to exactly one worker",
  { skip },
  async () => {
    const sql = client(),
      propertyId = "prop-seoul";
    try {
      await sql`DELETE FROM worker_attempts WHERE job_id='job-concurrency-saas'`;
      await sql`INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at) VALUES ('job-concurrency-saas',${propertyId},'USAGE_ROLLUP','concurrency-saas','{}'::jsonb,'PENDING',1,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET status='PENDING',attempts=0,available_at=clock_timestamp(),locked_at=NULL,locked_by=NULL,completed_at=NULL`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl });
      const [a, b] = await Promise.all([
        db.claimWorkerJobs("test:worker-a", 1),
        db.claimWorkerJobs("test:worker-b", 1),
      ]);
      assert.equal(a.length + b.length, 1);
      assert.equal([...a, ...b][0].id, "job-concurrency-saas");
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "new control tables remain isolated across property scopes",
  { skip },
  async () => {
    const sql = client();
    try {
      await sql`INSERT INTO backup_runs(id,property_id,backup_type,status,requested_by) VALUES ('backup-scope-a','prop-seoul','PROPERTY_EXPORT','REQUESTED','test') ON CONFLICT(id) DO NOTHING`;
      const [otherProperty] =
        await sql`SELECT id FROM properties WHERE id<>'prop-seoul' ORDER BY created_at DESC LIMIT 1`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        seoul = scopePmsDatabase(db, "prop-seoul"),
        other = scopePmsDatabase(db, otherProperty.id);
      assert.equal(
        Number(
          (
            await seoul
              .prepare(
                "SELECT COUNT(*) count FROM backup_runs WHERE property_id=pms_current_property_id() AND id='backup-scope-a'",
              )
              .first()
          ).count,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            await other
              .prepare(
                "SELECT COUNT(*) count FROM backup_runs WHERE id='backup-scope-a'",
              )
              .first()
          ).count,
        ),
        0,
      );
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "CSV migration dry-run, commit and rollback preserve reconciliation",
  { skip },
  async () => {
    const sql = client(),
      suffix = crypto.randomUUID().slice(0, 6).toUpperCase(),
      code = `I${suffix}`;
    try {
      const db = scopePmsDatabase(
          getPmsDatabase({ DATABASE_URL: databaseUrl }),
          "prop-seoul",
        ),
        csv = `code,name,base_rate,capacity,description\n${code},Integration Suite,199000,2,Imported by integration test\n`;
      const dryResponse = await dryRun(
          db,
          "integration@example.com",
          "ROOM_TYPES",
          `types-${suffix}.csv`,
          csv,
        ),
        dry = await dryResponse.json();
      assert.equal(dry.job.error_count, 0);
      const commitResponse = await commit(
          db,
          "integration@example.com",
          dry.job.id,
        ),
        committed = await commitResponse.json();
      assert.equal(committed.committed, 1);
      const [created] =
        await sql`SELECT rt.id,(SELECT COUNT(*)::int FROM room_type_website rw WHERE rw.room_type_id=rt.id) website_rows,(SELECT COUNT(*)::int FROM rate_plan_room_types rr WHERE rr.room_type_id=rt.id) plan_rows FROM room_types rt WHERE rt.property_id='prop-seoul' AND rt.code=${code}`;
      assert.equal(created.website_rows, 1);
      assert.ok(created.plan_rows >= 3);
      const rollbackResponse = await rollback(
          db,
          "integration@example.com",
          committed.jobId,
        ),
        rolled = await rollbackResponse.json();
      assert.equal(rolled.rolledBack, 1);
      const [remaining] =
        await sql`SELECT COUNT(*)::int count FROM room_types WHERE property_id='prop-seoul' AND code=${code}`;
      assert.equal(remaining.count, 0);
    } finally {
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);
