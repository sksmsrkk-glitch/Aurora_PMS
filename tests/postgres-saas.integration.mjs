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
import { getWebsiteContent } from "../app/api/booking/website-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "",
  skip = !databaseUrl;
const client = () =>
  postgres(databaseUrl, {
    max: 4,
    prepare: false,
    ssl: false,
    idle_timeout: 2,
  });

/** Provisioning intentionally spans several tenant masters whose foreign keys
 * are RESTRICT. Integration fixtures remove children explicitly so repeated
 * staging runs never become customer-like orphan properties. */
async function deleteProvisionedTestProperty(sql, propertyId) {
  await sql.begin(async (transaction) => {
    await transaction`DELETE FROM rooms WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM room_type_website WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM rate_plan_calendar WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM rate_plan_room_types WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM room_types WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM rate_plans WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM transaction_codes WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM accounting_accounts WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM audit_logs WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM role_assignments WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM property_domains WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM property_entitlements WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM property_subscriptions WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM website_settings WHERE property_id=${propertyId}`;
    await transaction`DELETE FROM properties WHERE id=${propertyId}`;
  });
}

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
      propertyId = `prop-saas-${suffix}`,
      slug = `saas-test-${suffix}`;
    try {
      await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'SaaS Test',${slug},'ACTIVE')`;
      await sql`INSERT INTO organization_memberships(id,organization_id,auth_user_id,email,display_name,role,active) VALUES (${`org-member-${suffix}`},${organizationId},${userId}::uuid,${email},'SaaS Owner','OWNER',true)`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        input = {
          propertyId,
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
      await sql`UPDATE website_settings SET published=true WHERE property_id=${input.propertyId}`;
      assert.equal((await getWebsiteContent(input.propertyId)).published, true);
      await sql`UPDATE property_subscriptions SET status='SUSPENDED' WHERE property_id=${input.propertyId}`;
      assert.equal(
        await db.resolvePublicProperty(input.hostname),
        null,
        "a suspended subscription must remove the public hotel site",
      );
      assert.equal(
        (await db.findActiveRoleAssignments(userId, email)).length,
        0,
        "a suspended tenant must not produce a login principal",
      );
      assert.equal(
        (await getWebsiteContent(input.propertyId)).published,
        false,
        "a suspended subscription must override the CMS publish switch",
      );
      await sql`UPDATE property_subscriptions SET status='CANCELLED' WHERE property_id=${input.propertyId}`;
      assert.equal(
        (await getWebsiteContent(input.propertyId)).published,
        false,
        "a cancelled subscription must override the CMS publish switch",
      );
      await sql`UPDATE property_subscriptions SET status='ACTIVE' WHERE property_id=${input.propertyId}`;
      assert.equal((await getWebsiteContent(input.propertyId)).published, true);
      assert.equal((await db.findActiveRoleAssignments(userId, email)).length, 1);
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
      await deleteProvisionedTestProperty(sql, propertyId);
      await sql`DELETE FROM organizations WHERE id=${organizationId}`;
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
      await sql`DELETE FROM audit_logs WHERE entity_type='support_session' AND entity_id IN (SELECT id FROM support_sessions WHERE operator_user_id=${operatorId}::uuid)`;
      await sql`DELETE FROM support_sessions WHERE operator_user_id=${operatorId}::uuid`;
      await sql`DELETE FROM support_access_grants WHERE operator_user_id=${operatorId}::uuid`;
      await sql`DELETE FROM platform_operators WHERE auth_user_id=${operatorId}::uuid AND email=${email}`;
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
      await deleteProvisionedTestProperty(sql, propertyId);
      await sql`DELETE FROM organizations WHERE id=${organizationId}`;
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
      await sql`DELETE FROM worker_attempts WHERE job_id='job-concurrency-saas'`;
      await sql`DELETE FROM worker_jobs WHERE id='job-concurrency-saas'`;
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "worker claim reaps ten-minute leases and closes every orphan attempt",
  { skip },
  async () => {
    const sql = client(),
      propertyId = "prop-seoul",
      suffix = crypto.randomUUID().slice(0, 8),
      pendingId = `job-claim-pending-${suffix}`,
      retryId = `job-claim-retry-${suffix}`,
      deadId = `job-claim-dead-${suffix}`,
      jobIds = [pendingId, retryId, deadId];
    try {
      await sql`INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,attempts,max_attempts,attempt_cycle,available_at,locked_at,locked_by,updated_at)
        VALUES (${pendingId},${propertyId},'USAGE_ROLLUP',${`claim-pending-${suffix}`} ,'{}'::jsonb,'PENDING',-1000,0,3,1,clock_timestamp(),NULL,NULL,clock_timestamp()),
               (${retryId},${propertyId},'USAGE_ROLLUP',${`claim-retry-${suffix}`} ,'{}'::jsonb,'RUNNING',100,1,3,1,clock_timestamp(),clock_timestamp()-interval '11 minutes','test:lost-retry',clock_timestamp()-interval '11 minutes'),
               (${deadId},${propertyId},'USAGE_ROLLUP',${`claim-dead-${suffix}`} ,'{}'::jsonb,'RUNNING',110,2,2,1,clock_timestamp(),clock_timestamp()-interval '11 minutes','test:lost-dead',clock_timestamp()-interval '11 minutes')`;
      // The older unfinished row simulates residue from a worker crash before
      // the latest attempt. Both rows must be closed by the lease reclamation.
      await sql`INSERT INTO worker_attempts(property_id,job_id,attempt_cycle,attempt_no,started_at)
        VALUES (${propertyId},${retryId},1,1,clock_timestamp()-interval '12 minutes'),
               (${propertyId},${deadId},1,1,clock_timestamp()-interval '13 minutes'),
               (${propertyId},${deadId},1,2,clock_timestamp()-interval '11 minutes')`;

      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        claimed = await db.claimWorkerJobs("test:lease-reaper", 1);
      assert.deepEqual(claimed.map((job) => job.id), [pendingId]);

      const jobs = await sql`SELECT id,status,locked_at,locked_by,completed_at,last_error FROM worker_jobs WHERE id IN (${pendingId},${retryId},${deadId})`,
        byId = new Map(jobs.map((job) => [job.id, job]));
      assert.equal(byId.get(retryId).status, "RETRY");
      assert.equal(byId.get(retryId).locked_by, null);
      assert.equal(byId.get(deadId).status, "DEAD");
      assert.ok(byId.get(deadId).completed_at);
      assert.match(byId.get(deadId).last_error, /lease expired/u);

      const attempts = await sql`SELECT job_id,attempt_no,outcome,error_code,completed_at FROM worker_attempts WHERE job_id IN (${retryId},${deadId}) ORDER BY job_id,attempt_no`;
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every((attempt) => attempt.completed_at));
      assert.ok(attempts.every((attempt) => attempt.error_code === "LEASE_EXPIRED"));
      assert.equal(attempts.find((attempt) => attempt.job_id === retryId).outcome, "RETRY");
      assert.ok(attempts.filter((attempt) => attempt.job_id === deadId).every((attempt) => attempt.outcome === "DEAD"));
    } finally {
      await sql`DELETE FROM worker_attempts WHERE job_id=ANY(${jobIds})`;
      await sql`DELETE FROM service_incidents WHERE id IN (${`incident-${retryId}`},${`incident-${deadId}`})`;
      await sql`DELETE FROM worker_jobs WHERE id=ANY(${jobIds})`;
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "enqueue triggers revive DEAD cycles without releasing RUNNING leases",
  { skip },
  async () => {
    const sql = client(),
      propertyId = "prop-seoul",
      suffix = crypto.randomUUID().slice(0, 8),
      outboxDead = `enqueue-outbox-dead-${suffix}`,
      outboxRunning = `enqueue-outbox-running-${suffix}`,
      ariDead = `enqueue-ari-dead-${suffix}`,
      ariRunning = `enqueue-ari-running-${suffix}`,
      jobIds = [
        `job-outbox-${outboxDead}`,
        `job-outbox-${outboxRunning}`,
        `job-ari-${ariDead}`,
        `job-ari-${ariRunning}`,
      ];
    try {
      await sql`INSERT INTO outbox_events(id,property_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at)
        VALUES (${outboxDead},${propertyId},'test.dead','test',${outboxDead},'{}'::jsonb,'PENDING',0,clock_timestamp()),
               (${outboxRunning},${propertyId},'test.running','test',${outboxRunning},'{}'::jsonb,'PENDING',0,clock_timestamp())`;
      await sql`INSERT INTO ari_updates(id,property_id,connection_id,mapping_id,stay_date,revision,available,closed,min_stay,close_to_arrival,close_to_departure,rate,currency,payload_json,status,attempts,created_at)
        VALUES (${ariDead},${propertyId},${`connection-${suffix}`},${`mapping-dead-${suffix}`},'2026-08-01',1,1,false,1,false,false,100000,'KRW','{}'::jsonb,'PENDING',0,clock_timestamp()),
               (${ariRunning},${propertyId},${`connection-${suffix}`},${`mapping-running-${suffix}`},'2026-08-02',1,1,false,1,false,false,100000,'KRW','{}'::jsonb,'PENDING',0,clock_timestamp())`;

      await sql`UPDATE worker_jobs SET status='DEAD',attempts=max_attempts,attempt_cycle=1,recovery_count=2,completed_at=clock_timestamp(),last_error='retry budget exhausted',locked_at=NULL,locked_by=NULL WHERE id IN (${jobIds[0]},${jobIds[2]})`;
      await sql`UPDATE worker_jobs SET status='RUNNING',attempts=1,attempt_cycle=1,locked_at=clock_timestamp(),locked_by='test:in-flight',last_error='in-flight marker' WHERE id IN (${jobIds[1]},${jobIds[3]})`;

      // A repeated source failure executes each enqueue trigger's conflict path.
      await sql`UPDATE outbox_events SET status='FAILED' WHERE id IN (${outboxDead},${outboxRunning})`;
      await sql`UPDATE ari_updates SET status='FAILED',last_error='source failed again' WHERE id IN (${ariDead},${ariRunning})`;

      const rows = await sql`SELECT id,status,attempts,attempt_cycle,recovery_count,locked_by,completed_at,last_error FROM worker_jobs WHERE id=ANY(${jobIds})`,
        byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of [jobIds[0], jobIds[2]]) {
        const job = byId.get(id);
        assert.equal(job.status, "RETRY");
        assert.equal(job.attempts, 0);
        assert.equal(job.attempt_cycle, 2);
        assert.equal(job.recovery_count, 2);
        assert.equal(job.locked_by, null);
        assert.equal(job.completed_at, null);
        assert.equal(job.last_error, null);
      }
      for (const id of [jobIds[1], jobIds[3]]) {
        const job = byId.get(id);
        assert.equal(job.status, "RUNNING");
        assert.equal(job.attempts, 1);
        assert.equal(job.attempt_cycle, 1);
        assert.equal(job.locked_by, "test:in-flight");
        assert.equal(job.last_error, "in-flight marker");
      }

      // Both revived jobs must enter attempt 1 of the new cycle without a
      // unique-key collision against their immutable previous history.
      await sql`UPDATE worker_jobs SET priority=-2000 WHERE id IN (${jobIds[0]},${jobIds[2]})`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        claimed = await db.claimWorkerJobs("test:dead-revival", 2);
      assert.deepEqual(new Set(claimed.map((job) => job.id)), new Set([jobIds[0], jobIds[2]]));
      assert.ok(claimed.every((job) => job.attempts === 1 && job.attempt_cycle === 2));
    } finally {
      await sql`DELETE FROM worker_attempts WHERE job_id=ANY(${jobIds})`;
      await sql`DELETE FROM service_incidents WHERE id=ANY(${jobIds.map((id) => `incident-${id}`)})`;
      await sql`DELETE FROM worker_jobs WHERE id=ANY(${jobIds})`;
      await sql`DELETE FROM outbox_events WHERE id IN (${outboxDead},${outboxRunning})`;
      await sql`DELETE FROM ari_updates WHERE id IN (${ariDead},${ariRunning})`;
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "worker reaper expires stale leases and reopens DEAD delivery in a bounded new cycle",
  { skip },
  async () => {
    const sql = client(),
      propertyId = "prop-seoul",
      suffix = crypto.randomUUID().slice(0, 8),
      retryId = `job-reaper-retry-${suffix}`,
      deadId = `job-reaper-dead-${suffix}`,
      resetId = `job-reaper-reset-${suffix}`,
      exhaustedRetryId = `job-reaper-exhausted-${suffix}`,
      voucherResetId = `job-reaper-voucher-${suffix}`;
    try {
      await sql`INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,attempts,max_attempts,attempt_cycle,available_at,locked_at,locked_by,updated_at)
        VALUES (${retryId},${propertyId},'USAGE_ROLLUP',${`reaper-retry-${suffix}`} ,'{}'::jsonb,'RUNNING',-200,1,3,1,clock_timestamp(),clock_timestamp()-interval '10 minutes','test:lost-a',clock_timestamp()-interval '10 minutes'),
               (${deadId},${propertyId},'USAGE_ROLLUP',${`reaper-dead-${suffix}`} ,'{}'::jsonb,'RUNNING',-190,2,2,1,clock_timestamp(),clock_timestamp()-interval '10 minutes','test:lost-b',clock_timestamp()-interval '10 minutes'),
               (${resetId},${propertyId},'OUTBOX_WEBHOOK',${`reaper-reset-${suffix}`} ,'{}'::jsonb,'DEAD',-300,2,2,1,clock_timestamp(),NULL,NULL,clock_timestamp()-interval '20 minutes'),
               (${exhaustedRetryId},${propertyId},'ARI_DELIVERY',${`reaper-exhausted-${suffix}`} ,'{}'::jsonb,'RETRY',-290,2,2,1,clock_timestamp(),NULL,NULL,clock_timestamp()-interval '20 minutes'),
               (${voucherResetId},${propertyId},'VOUCHER_EMAIL',${`reaper-voucher-${suffix}`} ,'{}'::jsonb,'DEAD',-310,2,2,1,clock_timestamp(),NULL,NULL,clock_timestamp()-interval '20 minutes')`;
      await sql`UPDATE worker_jobs SET completed_at=clock_timestamp()-interval '20 minutes' WHERE id IN (${resetId},${voucherResetId})`;
      await sql`INSERT INTO worker_attempts(property_id,job_id,attempt_cycle,attempt_no,started_at)
        VALUES (${propertyId},${retryId},1,1,clock_timestamp()-interval '10 minutes'),
               (${propertyId},${deadId},1,2,clock_timestamp()-interval '10 minutes'),
               (${propertyId},${resetId},1,1,clock_timestamp()-interval '30 minutes'),
               (${propertyId},${resetId},1,2,clock_timestamp()-interval '20 minutes')`;

      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        recovery = await db.recoverWorkerJobs({
          leaseSeconds: 90,
          deadCooldownSeconds: 60,
          maxRecoveries: 3,
          limit: 20,
        });
      assert.ok(recovery.staleRetried >= 1);
      assert.ok(recovery.staleDead >= 1);
      assert.ok(recovery.deadReset >= 3);
      const rows = await sql`SELECT id,status,attempts,attempt_cycle,recovery_count,locked_at,locked_by FROM worker_jobs WHERE id IN (${retryId},${deadId},${resetId},${exhaustedRetryId},${voucherResetId}) ORDER BY id`;
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(byId.get(retryId).status, "RETRY");
      assert.equal(byId.get(deadId).status, "DEAD");
      assert.equal(byId.get(resetId).status, "RETRY");
      assert.equal(byId.get(resetId).attempts, 0);
      assert.equal(byId.get(resetId).attempt_cycle, 2);
      assert.equal(byId.get(resetId).recovery_count, 1);
      assert.equal(byId.get(exhaustedRetryId).status, "RETRY");
      assert.equal(byId.get(exhaustedRetryId).attempts, 0);
      assert.equal(byId.get(exhaustedRetryId).attempt_cycle, 2);
      assert.equal(byId.get(voucherResetId).status, "RETRY");
      assert.equal(byId.get(voucherResetId).attempts, 0);
      assert.equal(byId.get(voucherResetId).attempt_cycle, 2);
      assert.equal(byId.get(retryId).locked_by, null);
      const [expiredAttempt] =
        await sql`SELECT outcome,error_code,completed_at FROM worker_attempts WHERE job_id=${retryId} AND attempt_cycle=1 AND attempt_no=1`;
      assert.equal(expiredAttempt.outcome, "RETRY");
      assert.equal(expiredAttempt.error_code, "LEASE_EXPIRED");
      assert.ok(expiredAttempt.completed_at);
      const claimed = await db.claimWorkerJobs("test:recovery-cycle", 3),
        resetClaim = claimed.find((job) => job.id === resetId);
      assert.ok(resetClaim, "the reset delivery must be claimable");
      assert.equal(resetClaim.attempt_cycle, 2);
      const [newCycleAttempt] =
        await sql`SELECT attempt_cycle,attempt_no FROM worker_attempts WHERE job_id=${resetId} AND attempt_cycle=2`;
      assert.equal(newCycleAttempt.attempt_no, 1);
    } finally {
      await sql`DELETE FROM worker_attempts WHERE job_id LIKE ${`job-reaper-%-${suffix}`}`;
      await sql`DELETE FROM service_incidents WHERE id LIKE ${`incident-job-reaper-%-${suffix}`}`;
      await sql`DELETE FROM worker_jobs WHERE id LIKE ${`job-reaper-%-${suffix}`}`;
      await sql.end({ timeout: 2 });
      await closePmsDatabase();
    }
  },
);

test(
  "new control tables remain isolated across property scopes",
  { skip },
  async () => {
    const sql = client(),
      suffix = crypto.randomUUID().slice(0, 8),
      organizationId = `org-scope-${suffix}`,
      propertyId = `prop-scope-${suffix}`;
    try {
      await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Scope Test',${`scope-${suffix}`},'ACTIVE')`;
      await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug,status,onboarding_status,plan_code,cell_key,settings) VALUES (${propertyId},'Scope Hotel',${`X${suffix.slice(0, 6)}`},'Asia/Seoul','KRW','2026-07-19',${organizationId},${`scope-hotel-${suffix}`},'ACTIVE','LIVE','STANDARD','primary','{}'::jsonb)`;
      await sql`INSERT INTO backup_runs(id,property_id,backup_type,status,requested_by) VALUES ('backup-scope-a','prop-seoul','PROPERTY_EXPORT','REQUESTED','test') ON CONFLICT(id) DO NOTHING`;
      const db = getPmsDatabase({ DATABASE_URL: databaseUrl }),
        seoul = scopePmsDatabase(db, "prop-seoul"),
        other = scopePmsDatabase(db, propertyId);
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
      await sql`DELETE FROM backup_runs WHERE id='backup-scope-a'`;
      await deleteProvisionedTestProperty(sql, propertyId);
      await sql`DELETE FROM organizations WHERE id=${organizationId}`;
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
          "ROOM_TYPES",
        ),
        committed = await commitResponse.json();
      assert.equal(committed.committed, 1);
      const replayResponse=await commit(db,"integration@example.com",dry.job.id,"ROOM_TYPES"),replayed=await replayResponse.json();
      assert.equal(replayed.replayed,true);
      assert.equal(replayed.jobId,committed.jobId);
      const [created] =
        await sql`SELECT rt.id,(SELECT COUNT(*)::int FROM room_type_website rw WHERE rw.room_type_id=rt.id) website_rows,(SELECT COUNT(*)::int FROM rate_plan_room_types rr WHERE rr.room_type_id=rt.id) plan_rows FROM room_types rt WHERE rt.property_id='prop-seoul' AND rt.code=${code}`;
      assert.equal(created.website_rows, 1);
      assert.ok(created.plan_rows >= 3);
      const rollbackResponse = await rollback(
          db,
          "integration@example.com",
          committed.jobId,
          "ROOM_TYPES",
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

test("reservation CSV can create an embedded guest and retry commit idempotently",{skip},async()=>{
  const sql=client(),suffix=crypto.randomUUID().slice(0,8).toUpperCase(),confirmation=`CSV-${suffix}`,external=`RES-${suffix}`,guestExternal=`GUEST-${suffix}`;
  try{
    const db=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul"),[type]=await sql`SELECT code FROM room_types WHERE property_id='prop-seoul' AND active ORDER BY code LIMIT 1`,[plan]=await sql`SELECT code FROM rate_plans WHERE property_id='prop-seoul' AND active ORDER BY code LIMIT 1`;
    const csv=`external_id,confirmation_no,guest_external_id,guest_first_name,guest_last_name,guest_email,guest_phone,room_type_code,arrival_date,departure_date,adults,children,source,rate_plan,nightly_rate,eta,notes\n${external},${confirmation},${guestExternal},길동,홍,csv-${suffix.toLowerCase()}@example.com,010-5555-5555,${type.code},2032-05-10,2032-05-12,2,0,HotelStory,${plan.code},188000,15:00,Embedded guest\n`;
    const dryPayload=await (await dryRun(db,"reservation-import@example.com","RESERVATIONS",`reservations-${suffix}.csv`,csv)).json();assert.equal(dryPayload.job.error_count,0);
    await assert.rejects(commit(db,"reservation-import@example.com",dryPayload.job.id,"ROOMS"),/검증 작업을 찾을 수 없습니다/u);
    const commitResponses=await Promise.all([commit(db,"reservation-import@example.com",dryPayload.job.id,"RESERVATIONS"),commit(db,"reservation-import@example.com",dryPayload.job.id,"RESERVATIONS")]),commitPayloads=await Promise.all(commitResponses.map(response=>response.json()));
    assert.equal(commitPayloads.filter(payload=>payload.replayed===true).length,1);assert.equal(new Set(commitPayloads.map(payload=>payload.jobId)).size,1);
    const committed=commitPayloads[0],replayed=await (await commit(db,"reservation-import@example.com",dryPayload.job.id,"RESERVATIONS")).json();assert.equal(replayed.replayed,true);assert.equal(replayed.jobId,committed.jobId);
    const [created]=await sql`SELECT r.id,g.id guest_id,g.first_name,g.last_name,(SELECT COUNT(*)::int FROM reservation_rate_nights n WHERE n.property_id=r.property_id AND n.reservation_id=r.id) rate_nights,(SELECT COALESCE(SUM(n.sell_rate),0)::numeric FROM reservation_rate_nights n WHERE n.property_id=r.property_id AND n.reservation_id=r.id) ledger_revenue FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id WHERE r.property_id='prop-seoul' AND r.confirmation_no=${confirmation}`;assert.equal(created.first_name,"길동");assert.equal(created.last_name,"홍");assert.equal(created.rate_nights,2);assert.equal(Number(created.ledger_revenue),376000);
    const [commitAudit]=await sql`SELECT after_json FROM audit_logs WHERE property_id='prop-seoul' AND entity_id=${committed.jobId} AND action='COMMIT_DATA_IMPORT'`;assert.equal(commitAudit.after_json.nightlyRateLedger,true);
    await assert.rejects(sql`DELETE FROM reservation_rate_nights WHERE property_id='prop-seoul' AND reservation_id=${created.id}`,/reservation rate nights are immutable/u);
    await assert.rejects(rollback(db,"reservation-import@example.com",committed.jobId,"ROOMS"),/반영 작업을 찾을 수 없습니다/u);
    const rolled=await (await rollback(db,"reservation-import@example.com",committed.jobId,"RESERVATIONS")).json();assert.equal(rolled.rolledBack,2);
    const [remaining]=await sql`SELECT COUNT(*)::int count FROM reservations WHERE property_id='prop-seoul' AND confirmation_no=${confirmation}`;assert.equal(remaining.count,0);
  }finally{await sql`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND actor='reservation-import@example.com'`;await sql.end({timeout:2});await closePmsDatabase();}
});
