/** Read-only impact check before the additive multi-hotel SaaS migration. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertStagingDatabaseTarget } from "./staging-db-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}
let local = {};
if (path.resolve(process.cwd()) === root) {
  try {
    local = parseEnv(
      await readFile(path.join(root, ".env.local"), "utf8"),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
const directUrl =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  local.DIRECT_URL ||
  local.DATABASE_URL ||
  "";
if (!/^postgres(?:ql)?:\/\//u.test(directUrl))
  throw new Error("DIRECT_URL is required");
if (
  process.env.PMS_ENVIRONMENT === "staging" ||
  process.env.PMS_QA_PROJECT_REF
)
  assertStagingDatabaseTarget();
const host = new URL(directUrl).hostname,
  projectRef =
    host.match(/^db\.([a-z0-9]+)\.supabase\.co$/u)?.[1] ||
    new URL(directUrl).username.match(/^postgres\.([a-z0-9]+)$/u)?.[1] ||
    "non-supabase",
  sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    ssl: /^(?:localhost|127\.0\.0\.1)$/u.test(host) ? false : "require",
    connect_timeout: 15,
    idle_timeout: 5,
  });
try {
  const [impact] = await sql`SELECT
    (SELECT id FROM pms_schema_migrations ORDER BY id DESC LIMIT 1) latest_migration,
    (SELECT COUNT(*)::int FROM properties) properties,
    (SELECT COUNT(*)::int FROM rooms WHERE active) active_rooms,
    (SELECT COUNT(*)::int FROM role_assignments WHERE active) active_users,
    (SELECT COUNT(*)::int FROM role_assignments WHERE role='PROPERTY_ADMIN' AND active AND auth_user_id IS NULL) unlinked_admins,
    (SELECT COUNT(*)::int FROM properties p WHERE NOT EXISTS(SELECT 1 FROM role_assignments ra WHERE ra.property_id=p.id AND ra.role='PROPERTY_ADMIN' AND ra.active AND ra.auth_user_id IS NOT NULL)) properties_without_linked_owner,
    (SELECT COUNT(*)::int FROM (SELECT trim(both '-' from lower(regexp_replace(code,'[^a-zA-Z0-9]+','-','g'))) slug FROM properties GROUP BY 1 HAVING COUNT(*)>1) duplicates) duplicate_property_slugs,
    (SELECT COUNT(*)::int FROM properties WHERE trim(both '-' from lower(regexp_replace(code,'[^a-zA-Z0-9]+','-','g'))) !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') invalid_property_slugs`;
  console.log(JSON.stringify({ projectRef, ...impact }, null, 2));
  if (
    impact.duplicate_property_slugs ||
    impact.invalid_property_slugs ||
    impact.properties_without_linked_owner
  )
    throw new Error(
      "Property ownership or slug normalization must be corrected before migration",
    );
} finally {
  await sql.end({ timeout: 5 });
}
