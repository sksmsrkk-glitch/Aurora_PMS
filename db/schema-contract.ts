/** Runtime database contract shared by health probes, API startup, and releases. */
import type { PmsDatabase } from "./pms-database";

// Bump this value in the same change that adds the latest required migration.
// A unit test keeps it synchronized with the migration directory.
export const REQUIRED_SCHEMA_VERSION = "202607170013_native_flags_json_constraints";
export const REQUIRED_TENANT_POLICY_COUNT = 52;

type RuntimeContractRow = {
  migration_ready: boolean;
  role_ready: boolean;
  role_member: boolean;
  policy_count: number;
};

export class PmsSchemaNotReadyError extends Error {
  readonly code = "SCHEMA_NOT_READY";

  constructor(readonly details: string[]) {
    super(`Aurora PMS database contract is not ready: ${details.join(", ")}`);
    this.name = "PmsSchemaNotReadyError";
  }
}

/**
 * Verifies only PostgreSQL catalogs and migration history, so it is safe to run
 * before a tenant has been selected. Tenant data remains inaccessible here.
 */
export async function verifyPmsSchemaContract(db: PmsDatabase) {
  const row = await db.prepare(
    `SELECT
       EXISTS(
         SELECT 1 FROM pms_schema_migrations WHERE id=?
       ) migration_ready,
       EXISTS(
         SELECT 1 FROM pg_roles
          WHERE rolname='aurora_app'
            AND rolcanlogin=false
            AND rolbypassrls=false
            AND rolsuper=false
       ) role_ready,
       pg_has_role(current_user,'aurora_app','MEMBER') role_member,
       (
         SELECT COUNT(*)::int
           FROM pg_policies
          WHERE policyname='aurora_property_isolation'
            AND 'aurora_app'=ANY(roles)
       ) policy_count`,
  ).bind(REQUIRED_SCHEMA_VERSION).first<RuntimeContractRow>();

  const failures: string[] = [];
  if (!row?.migration_ready) failures.push(`migration ${REQUIRED_SCHEMA_VERSION}`);
  if (!row?.role_ready) failures.push("hardened aurora_app role");
  if (!row?.role_member) failures.push("runtime role membership");
  if (Number(row?.policy_count || 0) < REQUIRED_TENANT_POLICY_COUNT) {
    failures.push(`tenant policies ${Number(row?.policy_count || 0)}/${REQUIRED_TENANT_POLICY_COUNT}`);
  }
  if (failures.length) throw new PmsSchemaNotReadyError(failures);
  return { version: REQUIRED_SCHEMA_VERSION, policyCount: Number(row?.policy_count) };
}

export function schemaNotReadyResponse(error: unknown) {
  if (!(error instanceof PmsSchemaNotReadyError)) return null;
  return Response.json(
    {
      error: "데이터베이스 업그레이드가 완료되지 않아 잠시 사용할 수 없습니다.",
      code: error.code,
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    },
  );
}
