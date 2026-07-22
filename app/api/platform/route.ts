/** Authenticated SaaS control-plane portfolio and lifecycle commands. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getPmsDatabase, scopePmsDatabase } from "../../../db/pms-database";
import { schemaNotReadyResponse } from "../../../db/schema-contract";
import { ROLE_ACCESS_TEMPLATES } from "../../access-control";
import { PMS_WORKSPACES } from "../../pms-workspaces";
import { rememberSelectedProperty } from "../../property-selection";
import { authenticateSupabaseRequest } from "../../supabase-session";
import { scheduleDurableWorkerKick } from "../../worker-kick";
import { consumeRateLimit, rateLimitHeaders } from "../rate-limit";
import { safeRouteError } from "../safe-route-error";
import { principalFor, ready, runtimeBindings } from "../pms/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const propertyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select_property"), propertyId }),
  z.object({
    action: z.literal("provision_property"),
    organizationId: z.string().regex(/^org-[A-Za-z0-9_-]{3,64}$/u),
    name: z.string().trim().min(2).max(120),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{2,16}$/u),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    timezone: z
      .string()
      .trim()
      .regex(/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/u)
      .default("Asia/Seoul"),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/u)
      .default("KRW"),
    businessDate: isoDate,
    planCode: z.enum(["STARTER", "STANDARD", "PRO"]).default("STANDARD"),
  }),
  z.object({
    action: z.literal("request_backup"),
    backupType: z.enum([
      "DATABASE_SNAPSHOT",
      "PROPERTY_EXPORT",
      "RESTORE_REHEARSAL",
    ]),
  }),
  z.object({
    action: z.literal("add_domain"),
    hostname: z.string().trim().toLowerCase().max(253),
    kind: z.enum(["CUSTOM", "SUBDOMAIN"]).default("CUSTOM"),
  }),
  z.object({
    action: z.literal("create_support_grant"),
    operatorUserId: z.string().uuid(),
    operatorEmail: z.string().email().max(254).toLowerCase(),
    accessMode: z.enum(["READ", "WRITE"]).default("READ"),
    piiMode: z.enum(["MASKED", "FULL"]).default("MASKED"),
    workspaces: z
      .array(z.enum(PMS_WORKSPACES))
      .min(1)
      .max(PMS_WORKSPACES.length),
    reason: z.string().trim().min(10).max(1000),
    ticketReference: z.string().trim().min(3).max(80),
    expiresInMinutes: z.number().int().min(15).max(480).default(60),
  }),
  z.object({
    action: z.literal("revoke_support_grant"),
    grantId: z.string().regex(/^[A-Za-z0-9:_-]{3,200}$/u),
  }),
]);

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
function jsonHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

async function context(request: Request) {
  const db = getPmsDatabase(runtimeBindings);
  try {
    await ready(db);
  } catch (error) {
    const response = schemaNotReadyResponse(error);
    if (response) return { response };
    throw error;
  }
  const [identity, principal] = await Promise.all([
    authenticateSupabaseRequest(request),
    principalFor(request, db),
  ]);
  if (!identity)
    return {
      response: Response.json(
        { error: "로그인이 필요합니다." },
        { status: 401, headers: jsonHeaders() },
      ),
    };
  if (!principal)
    return {
      response: Response.json(
        {
          error:
            "현재 접근 가능한 호텔이 없습니다. 호텔 상태와 계정 배정을 확인해 주세요.",
          code: "TENANT_ACCESS_INACTIVE",
        },
        { status: 403, headers: jsonHeaders() },
      ),
    };
  return { db, identity, principal };
}

export async function GET(request: Request) {
  const resolved = await context(request);
  if ("response" in resolved) return resolved.response;
  const { db, identity, principal } = resolved;
  if (!principal.capabilities.includes("USER_ADMIN"))
    return Response.json(
      { error: "멀티호텔 관리 권한이 필요합니다." },
      { status: 403, headers: jsonHeaders() },
    );
  const portfolio = await db.loadPlatformPortfolio(identity.id, identity.email);
  const scoped = scopePmsDatabase(db, principal.propertyId);
  const [
    subscriptions,
    entitlements,
    imports,
    support,
    jobs,
    backups,
    incidents,
  ] = await scoped.batch([
    scoped.prepare(
      "SELECT * FROM property_subscriptions WHERE property_id=pms_current_property_id() LIMIT 1",
    ),
    scoped.prepare(
      "SELECT feature_key,enabled,limits FROM property_entitlements WHERE property_id=pms_current_property_id() ORDER BY feature_key",
    ),
    scoped.prepare(
      "SELECT id,kind,mode,status,source_name,row_count,valid_count,error_count,summary,created_at,created_by,committed_at,rolled_back_at FROM data_import_jobs WHERE property_id=pms_current_property_id() ORDER BY created_at DESC LIMIT 20",
    ),
    scoped.prepare(
      "SELECT id,operator_email,access_mode,pii_mode,reason,ticket_reference,starts_at,expires_at,approved_by,revoked_at FROM support_access_grants WHERE property_id=pms_current_property_id() ORDER BY created_at DESC LIMIT 20",
    ),
    scoped.prepare(
      "SELECT id,job_type,status,attempts,max_attempts,available_at,completed_at,last_error,created_at FROM worker_jobs WHERE property_id=pms_current_property_id() ORDER BY created_at DESC LIMIT 30",
    ),
    scoped.prepare(
      "SELECT id,backup_type,status,storage_reference,size_bytes,requested_at,completed_at,verified_at,error_message FROM backup_runs WHERE property_id=pms_current_property_id() ORDER BY requested_at DESC LIMIT 20",
    ),
    scoped.prepare(
      "SELECT id,component,severity,status,summary,started_at,acknowledged_at,resolved_at FROM service_incidents WHERE property_id=pms_current_property_id() ORDER BY started_at DESC LIMIT 20",
    ),
  ]);
  return Response.json(
    {
      currentPropertyId: principal.propertyId,
      organizationId: principal.organizationId,
      organizationName: principal.organizationName,
      identity: {
        email: identity.email,
        displayName: principal.displayName,
        assuranceLevel: identity.assuranceLevel,
      },
      portfolio,
      subscription: subscriptions.results[0] ?? null,
      entitlements: entitlements.results,
      imports: imports.results,
      supportGrants: support.results,
      jobs: jobs.results,
      backups: backups.results,
      incidents: incidents.results,
      configuration: {
        tenantBaseDomain: process.env.AURORA_TENANT_BASE_DOMAIN || null,
        platformMfaRequired: process.env.PMS_REQUIRE_PLATFORM_MFA !== "false",
      },
    },
    { headers: jsonHeaders() },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return Response.json(
      { error: "허용되지 않은 요청 출처입니다." },
      { status: 403, headers: jsonHeaders() },
    );
  if (Number(request.headers.get("content-length") || 0) > 65_536)
    return Response.json(
      { error: "요청 크기가 너무 큽니다." },
      { status: 413, headers: jsonHeaders() },
    );
  const resolved = await context(request);
  if ("response" in resolved) return resolved.response;
  const { db, identity, principal } = resolved;
  let limit;
  try {
    limit = await consumeRateLimit(
      request,
      "platform-write",
      30,
      60_000,
      `${identity.id}:${principal.propertyId}`,
      db,
    );
  } catch {
    return Response.json(
      { error: "요청 보호 서비스를 사용할 수 없습니다." },
      { status: 503, headers: jsonHeaders() },
    );
  }
  if (!limit.allowed)
    return Response.json(
      { error: "요청이 너무 많습니다." },
      {
        status: 429,
        headers: { ...jsonHeaders(), ...rateLimitHeaders(limit) },
      },
    );
  let parsed: z.infer<typeof actionSchema>;
  try {
    parsed = actionSchema.parse(await request.json());
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues
                .map((item) => `${item.path.join(".")}: ${item.message}`)
                .join(", ")
            : "요청 형식을 확인해 주세요.",
      },
      { status: 400, headers: jsonHeaders() },
    );
  }

  if (parsed.action === "select_property") {
    if (
      !principal.availableProperties.some(
        (item) => item.id === parsed.propertyId,
      )
    )
      return Response.json(
        { error: "접근할 수 없는 호텔입니다." },
        { status: 403, headers: jsonHeaders() },
      );
    await rememberSelectedProperty(parsed.propertyId);
    return Response.json(
      { ok: true, propertyId: parsed.propertyId },
      { headers: jsonHeaders() },
    );
  }
  if (!principal.capabilities.includes("USER_ADMIN"))
    return Response.json(
      { error: "호텔 SaaS 관리 권한이 필요합니다." },
      { status: 403, headers: jsonHeaders() },
    );
  const requireMfa = process.env.PMS_REQUIRE_PLATFORM_MFA !== "false";
  if (requireMfa && identity.assuranceLevel !== "aal2")
    return Response.json(
      { error: "이 작업은 MFA 추가 인증이 필요합니다.", code: "MFA_REQUIRED" },
      { status: 403, headers: jsonHeaders() },
    );

  try {
    if (parsed.action === "provision_property") {
      const baseDomain = (process.env.AURORA_TENANT_BASE_DOMAIN || "")
        .trim()
        .toLowerCase();
      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          baseDomain,
        )
      )
        return Response.json(
          { error: "테넌트 기본 도메인 설정이 필요합니다." },
          { status: 503, headers: jsonHeaders() },
        );
      const digest = createHash("sha256")
        .update(`${parsed.organizationId}:${parsed.slug}`)
        .digest("hex")
        .slice(0, 8);
      const compactSlug = parsed.slug.slice(0, 46).replace(/-+$/u, "");
      const propertyIdValue = `prop-${compactSlug}-${digest}`;
      const provisioned = await db.provisionProperty({
        propertyId: propertyIdValue,
        organizationId: parsed.organizationId,
        authUserId: identity.id,
        actorEmail: identity.email,
        actorName: principal.displayName,
        name: parsed.name,
        code: parsed.code,
        slug: parsed.slug,
        timezone: parsed.timezone,
        currency: parsed.currency,
        businessDate: parsed.businessDate,
        planCode: parsed.planCode,
        hostname: `${parsed.slug}.${baseDomain}`,
        workspacePermissions: ROLE_ACCESS_TEMPLATES.PROPERTY_ADMIN.permissions,
      });
      return Response.json(
        { ok: true, ...provisioned },
        { status: 201, headers: jsonHeaders() },
      );
    }
    const scoped = scopePmsDatabase(db, principal.propertyId),
      now = new Date(),
      id = randomUUID();
    if (parsed.action === "request_backup") {
      await scoped.batch([
        scoped
          .prepare(
            "INSERT INTO backup_runs(id,property_id,backup_type,status,requested_at,requested_by) VALUES (?,pms_current_property_id(),?,'REQUESTED',?,?)",
          )
          .bind(id, parsed.backupType, now.toISOString(), identity.email),
        scoped
          .prepare(
            "INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at) VALUES (?,pms_current_property_id(),'BACKUP_VERIFY',?,'{}'::jsonb,'PENDING',80,?)",
          )
          .bind(`job-backup-${id}`, id, now.toISOString()),
        scoped
          .prepare(
            "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'REQUEST_BACKUP','backup_run',?,NULL,jsonb_build_object('type',?::text),?)",
          )
          .bind(
            `audit-backup-${id}`,
            identity.email,
            id,
            parsed.backupType,
            now.toISOString(),
          ),
      ]);
      scheduleDurableWorkerKick();
      return Response.json(
        { ok: true, id },
        { status: 201, headers: jsonHeaders() },
      );
    }
    if (parsed.action === "add_domain") {
      const hostname = parsed.hostname.replace(/\.$/u, "");
      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          hostname,
        )
      )
        return Response.json(
          { error: "유효한 도메인을 입력해 주세요." },
          { status: 400, headers: jsonHeaders() },
        );
      const token = randomUUID(),
        tokenHash = createHash("sha256").update(token).digest("hex");
      await scoped.batch([
        scoped
          .prepare(
            "INSERT INTO property_domains(id,property_id,hostname,kind,status,is_primary,verification_token_hash,created_at,updated_at) VALUES (?,pms_current_property_id(),?,?,'PENDING',false,?,?,?)",
          )
          .bind(
            id,
            hostname,
            parsed.kind,
            tokenHash,
            now.toISOString(),
            now.toISOString(),
          ),
        scoped
          .prepare(
            "INSERT INTO worker_jobs(id,property_id,job_type,source_id,payload,status,priority,available_at) VALUES (?,pms_current_property_id(),'DOMAIN_VERIFY',?,jsonb_build_object('hostname',?::text),'PENDING',60,?)",
          )
          .bind(`job-domain-${id}`, id, hostname, now.toISOString()),
      ]);
      scheduleDurableWorkerKick();
      return Response.json(
        {
          ok: true,
          id,
          hostname,
          dnsVerification: {
            type: "TXT",
            name: `_talos.${hostname}`,
            value: `talos-verification=${token}`,
          },
        },
        { status: 201, headers: jsonHeaders() },
      );
    }
    if (parsed.action === "create_support_grant") {
      const selected = new Set(parsed.workspaces),
        permissions = Object.fromEntries(
          PMS_WORKSPACES.map((workspace) => [
            workspace,
            selected.has(workspace) ? parsed.accessMode : "NONE",
          ]),
        );
      const expiresAt = new Date(
        now.getTime() + parsed.expiresInMinutes * 60_000,
      );
      await scoped.batch([
        scoped
          .prepare(
            "INSERT INTO support_access_grants(id,property_id,operator_user_id,operator_email,access_mode,workspace_permissions,pii_mode,reason,ticket_reference,starts_at,expires_at,approved_by,approved_at,created_at) VALUES (?,pms_current_property_id(),?::uuid,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            id,
            parsed.operatorUserId,
            parsed.operatorEmail,
            parsed.accessMode,
            permissions,
            parsed.piiMode,
            parsed.reason,
            parsed.ticketReference,
            now.toISOString(),
            expiresAt.toISOString(),
            identity.email,
            now.toISOString(),
            now.toISOString(),
          ),
        scoped
          .prepare(
            "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'GRANT_SUPPORT_ACCESS','support_grant',?,NULL,jsonb_build_object('operator',?::text,'mode',?::text,'piiMode',?::text,'expiresAt',?::text),?)",
          )
          .bind(
            `audit-support-${id}`,
            identity.email,
            id,
            parsed.operatorEmail,
            parsed.accessMode,
            parsed.piiMode,
            expiresAt.toISOString(),
            now.toISOString(),
          ),
      ]);
      return Response.json(
        { ok: true, id, expiresAt: expiresAt.toISOString() },
        { status: 201, headers: jsonHeaders() },
      );
    }
    if (parsed.action === "revoke_support_grant") {
      const result = await scoped.batch([
        scoped
          .prepare(
            "UPDATE support_access_grants SET revoked_at=?,revoked_by=? WHERE id=? AND property_id=pms_current_property_id() AND revoked_at IS NULL RETURNING id",
          )
          .bind(now.toISOString(), identity.email, parsed.grantId),
        scoped
          .prepare(
            "UPDATE support_sessions SET ended_at=? WHERE grant_id=? AND property_id=pms_current_property_id() AND ended_at IS NULL",
          )
          .bind(now.toISOString(), parsed.grantId),
        scoped
          .prepare(
            "INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?,pms_current_property_id(),?,'REVOKE_SUPPORT_ACCESS','support_grant',?,NULL,jsonb_build_object('revoked',true),?)",
          )
          .bind(
            `audit-revoke-${id}`,
            identity.email,
            parsed.grantId,
            now.toISOString(),
          ),
      ]);
      if (!result[0].results.length)
        return Response.json(
          { error: "활성 지원 권한을 찾을 수 없습니다." },
          { status: 404, headers: jsonHeaders() },
        );
      return Response.json({ ok: true }, { headers: jsonHeaders() });
    }
  } catch (error) {
    const failure = safeRouteError(error, {
      context: "platform-command",
      conflicts: [{
        pattern: /unique|duplicate|already/iu,
        error: "이미 사용 중인 코드·호텔명·도메인입니다.",
      }],
    });
    return Response.json(
      failure.body,
      { status: failure.status, headers: jsonHeaders() },
    );
  }
  return Response.json(
    { error: "지원하지 않는 작업입니다." },
    { status: 400, headers: jsonHeaders() },
  );
}
