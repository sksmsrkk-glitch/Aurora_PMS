/** Explicit break-glass registry management for Aurora support operators. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

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
const directUrl = process.env.DIRECT_URL || local.DIRECT_URL || "",
  [command, userId, emailInput, roleInput = "SUPPORT", ...nameParts] =
    process.argv.slice(2),
  email = String(emailInput || "")
    .trim()
    .toLowerCase(),
  displayName =
    nameParts.join(" ").trim() || email.split("@")[0] || "Aurora Support",
  role = String(roleInput).toUpperCase();
if (process.env.AURORA_PLATFORM_OPERATOR_CONFIRM !== "AURORA_PLATFORM_OPERATOR")
  throw new Error(
    "AURORA_PLATFORM_OPERATOR_CONFIRM=AURORA_PLATFORM_OPERATOR is required",
  );
if (!/^postgres(?:ql)?:\/\//u.test(directUrl))
  throw new Error("DIRECT_URL is required");
if (
  !["upsert", "disable"].includes(command) ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    String(userId || ""),
  ) ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
)
  throw new Error(
    "Usage: upsert|disable <auth-user-uuid> <email> [SUPPORT|SUPPORT_ADMIN|SECURITY_ADMIN] [display name]",
  );
if (
  !["SUPPORT", "SUPPORT_ADMIN", "SECURITY_ADMIN"].includes(role) ||
  displayName.length < 2 ||
  displayName.length > 80
)
  throw new Error("Invalid operator role or display name");

const host = new URL(directUrl).hostname,
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
    [userId, email],
  );
  if (!authUser.length)
    throw new Error("Supabase Auth user ID and email do not match");
  if (command === "disable") {
    const rows =
      await sql`UPDATE platform_operators SET active=false,updated_at=clock_timestamp() WHERE auth_user_id=${userId}::uuid AND lower(email)=${email} RETURNING auth_user_id`;
    if (!rows.length) throw new Error("Platform operator was not found");
  } else {
    await sql`INSERT INTO platform_operators(auth_user_id,email,display_name,role,active) VALUES (${userId}::uuid,${email},${displayName},${role},true) ON CONFLICT(auth_user_id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,role=excluded.role,active=true,updated_at=clock_timestamp()`;
  }
  console.log(`Platform operator ${command} completed for ${email}.`);
} finally {
  await sql.end({ timeout: 5 });
}
