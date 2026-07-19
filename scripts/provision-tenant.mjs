/** Idempotent operator onboarding for a new customer organization and first hotel. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { ROLE_ACCESS_TEMPLATES } from "../app/access-control.ts";
import { closePmsDatabase, getPmsDatabase } from "../db/pms-database.ts";

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
try {
  local = parseEnv(
    await readFile(path.join(process.cwd(), ".env.local"), "utf8"),
  );
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}
const env = { ...local, ...process.env },
  directUrl = env.DIRECT_URL || "",
  operatorEmail = (env.AURORA_TENANT_PROVISIONED_BY || "").trim().toLowerCase(),
  organizationId = env.AURORA_TENANT_ORGANIZATION_ID || "",
  organizationName = env.AURORA_TENANT_ORGANIZATION_NAME || "",
  organizationSlug = (env.AURORA_TENANT_ORGANIZATION_SLUG || "").toLowerCase(),
  ownerUserId = (env.AURORA_TENANT_OWNER_USER_ID || "").toLowerCase(),
  ownerEmail = (env.AURORA_TENANT_OWNER_EMAIL || "").trim().toLowerCase(),
  ownerName = (env.AURORA_TENANT_OWNER_NAME || "").trim(),
  hotelName = (env.AURORA_TENANT_HOTEL_NAME || "").trim(),
  hotelCode = (env.AURORA_TENANT_HOTEL_CODE || "").trim().toUpperCase(),
  hotelSlug = (env.AURORA_TENANT_HOTEL_SLUG || "").trim().toLowerCase(),
  baseDomain = (env.AURORA_TENANT_BASE_DOMAIN || "").trim().toLowerCase(),
  timezone = env.AURORA_TENANT_TIMEZONE || "Asia/Seoul",
  currency = (env.AURORA_TENANT_CURRENCY || "KRW").toUpperCase(),
  businessDate =
    env.AURORA_TENANT_BUSINESS_DATE || new Date().toISOString().slice(0, 10),
  planCode = (env.AURORA_TENANT_PLAN_CODE || "STANDARD").toUpperCase();
if (env.AURORA_TENANT_PROVISION_CONFIRM !== "AURORA_TENANT_PROVISION")
  throw new Error(
    "AURORA_TENANT_PROVISION_CONFIRM=AURORA_TENANT_PROVISION is required",
  );
if (
  !/^postgres(?:ql)?:\/\//u.test(directUrl) ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(operatorEmail) ||
  !/^org-[A-Za-z0-9_-]{3,64}$/u.test(organizationId) ||
  organizationName.trim().length < 2 ||
  !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(organizationSlug) ||
  !/^[0-9a-f-]{36}$/u.test(ownerUserId) ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail) ||
  ownerName.length < 2 ||
  hotelName.length < 2 ||
  !/^[A-Z0-9_-]{2,16}$/u.test(hotelCode) ||
  !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hotelSlug) ||
  !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
    baseDomain,
  ) ||
  !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate) ||
  !["STARTER", "STANDARD", "PRO"].includes(planCode)
)
  throw new Error("Tenant provisioning environment is incomplete or invalid");
const propertyDigest = createHash("sha256")
    .update(`${organizationId}:${hotelSlug}`)
    .digest("hex")
    .slice(0, 8),
  propertyId = `prop-${hotelSlug.slice(0, 46).replace(/-+$/u, "")}-${propertyDigest}`,
  membershipId = `org-member-${createHash("sha256").update(`${organizationId}:${ownerUserId}`).digest("hex").slice(0, 24)}`,
  host = new URL(directUrl).hostname,
  sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    ssl: /^(?:localhost|127\.0\.0\.1)$/u.test(host) ? false : "require",
    connect_timeout: 15,
    idle_timeout: 5,
  });
try {
  const authUser = await sql.unsafe(
    "SELECT id,email FROM auth.users WHERE id=$1::uuid AND lower(email)=lower($2) LIMIT 1",
    [ownerUserId, ownerEmail],
  );
  if (!authUser.length)
    throw new Error("Supabase Auth owner ID and email do not match");
  const operator =
    await sql`SELECT auth_user_id FROM platform_operators WHERE lower(email)=${operatorEmail} AND active AND role IN ('SUPPORT_ADMIN','SECURITY_ADMIN') LIMIT 1`;
  if (!operator.length)
    throw new Error(
      "An active SUPPORT_ADMIN or SECURITY_ADMIN operator is required",
    );
  await sql.begin(async (transaction) => {
    await transaction`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},${organizationName},${organizationSlug},'TRIAL') ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=clock_timestamp()`;
    await transaction`INSERT INTO organization_memberships(id,organization_id,auth_user_id,email,display_name,role,active) VALUES (${membershipId},${organizationId},${ownerUserId}::uuid,${ownerEmail},${ownerName},'OWNER',true) ON CONFLICT(organization_id,auth_user_id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,role='OWNER',active=true,updated_at=clock_timestamp()`;
  });
  const db = getPmsDatabase({ DATABASE_URL: directUrl }),
    result = await db.provisionProperty({
      propertyId,
      organizationId,
      authUserId: ownerUserId,
      actorEmail: ownerEmail,
      actorName: ownerName,
      name: hotelName,
      code: hotelCode,
      slug: hotelSlug,
      timezone,
      currency,
      businessDate,
      planCode,
      hostname: `${hotelSlug}.${baseDomain}`,
      workspacePermissions: ROLE_ACCESS_TEMPLATES.PROPERTY_ADMIN.permissions,
    });
  await sql`INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (${`audit-tenant-${crypto.randomUUID()}`},${result.propertyId},${operatorEmail},'OPERATOR_TENANT_PROVISION','organization',${organizationId},NULL,${sql.json({ propertyId: result.propertyId, ownerEmail, planCode })},clock_timestamp())`;
  console.log(
    `Tenant provisioned: ${organizationId} / ${result.propertyId} / ${result.hostname}.`,
  );
} finally {
  await sql.end({ timeout: 5 });
  await closePmsDatabase();
}
