/** Read-only release gate for migration, role, RLS, and pooled SET ROLE support. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  REQUIRED_SCHEMA_VERSION,
  REQUIRED_TENANT_POLICY_COUNT,
} from "../db/schema-contract.ts";

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[trimmed.slice(0, separator).trim()] = value;
  }
  return values;
}

let localEnv = {};
try {
  localEnv = parseEnv(await readFile(path.join(process.cwd(), ".env.local"), "utf8"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const databaseUrl = process.env.DATABASE_URL || localEnv.DATABASE_URL;
const propertyId = process.env.AURORA_PUBLIC_PROPERTY_ID || localEnv.AURORA_PUBLIC_PROPERTY_ID || "prop-seoul";
if (!databaseUrl || !/^postgres(?:ql)?:\/\//u.test(databaseUrl)) throw new Error("DATABASE_URL is missing or invalid");
if (!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId)) throw new Error("AURORA_PUBLIC_PROPERTY_ID is invalid");

const url = new URL(databaseUrl);
const local = /^(?:localhost|127\.0\.0\.1)$/u.test(url.hostname);
const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl: local ? false : "require", connect_timeout: 15, idle_timeout: 5 });
try {
  const [catalog] = await sql`
    SELECT
      EXISTS(SELECT 1 FROM pms_schema_migrations WHERE id=${REQUIRED_SCHEMA_VERSION}) migration_ready,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='aurora_app' AND rolcanlogin=false AND rolbypassrls=false AND rolsuper=false) role_ready,
      pg_has_role(current_user,'aurora_app','MEMBER') role_member,
      (SELECT COUNT(*)::int FROM pg_policies WHERE policyname='aurora_property_isolation' AND 'aurora_app'=ANY(roles)) policy_count
  `;
  if (!catalog.migration_ready || !catalog.role_ready || !catalog.role_member || Number(catalog.policy_count) < REQUIRED_TENANT_POLICY_COUNT) {
    throw new Error("Database catalog does not satisfy the Aurora runtime contract");
  }

  const tenantProbe = await sql.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL ROLE aurora_app");
    await transaction`SELECT set_config('app.property_id',${propertyId},true)`;
    const [result] = await transaction`SELECT id FROM properties WHERE id=pms_current_property_id()`;
    return result;
  });
  if (tenantProbe?.id !== propertyId) throw new Error("Tenant role probe did not return the configured property");
  console.log(`Aurora runtime contract passed: ${REQUIRED_SCHEMA_VERSION}, ${catalog.policy_count} tenant policies, pooled role probe ready.`);
} finally {
  await sql.end({ timeout: 5 });
}
