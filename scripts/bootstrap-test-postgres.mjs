/** Creates only the Supabase-owned roles and storage surface required by migrations. */
import postgres from "postgres";

const directUrl = process.env.DIRECT_URL || process.env.TEST_DATABASE_URL || "";
if (!/^postgres(?:ql)?:\/\//u.test(directUrl)) {
  throw new Error("DIRECT_URL or TEST_DATABASE_URL is required");
}

const host = new URL(directUrl).hostname;
const sql = postgres(directUrl, {
  max: 1,
  prepare: false,
  ssl: /^(?:localhost|127\.0\.0\.1)$/u.test(host) ? false : "require",
});

try {
  // Supabase provides these roles and storage tables in hosted projects. A plain
  // PostgreSQL CI service needs a minimal compatible shell before Aurora SQL runs.
  await sql.unsafe(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END
    $roles$;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  console.log("PostgreSQL test compatibility surface is ready.");
} finally {
  await sql.end({ timeout: 5 });
}
