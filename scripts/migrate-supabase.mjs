/** Ordered, history-aware Supabase migration and seed runner. */
import { readFile, readdir } from "node:fs/promises";
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
    if (separator<1) continue;
    const key = trimmed.slice(0,separator).trim();
    let value = trimmed.slice(separator+1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
    values[key]=value;
  }
  return values;
}

let env = {};
if(path.resolve(process.cwd())===root){
  try {
    env = parseEnv(await readFile(path.join(root,".env.local"),"utf8"));
  } catch (error) {
    // CI supplies DIRECT_URL directly and intentionally has no developer env file.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
const directUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || env.DIRECT_URL || env.DATABASE_URL;
if (!directUrl || !/^postgres(?:ql)?:\/\//u.test(directUrl)) throw new Error("DIRECT_URL is missing or invalid");
if(process.env.PMS_ENVIRONMENT==="staging"||process.env.PMS_QA_PROJECT_REF)assertStagingDatabaseTarget();

const directHost=new URL(directUrl).hostname;
const sql = postgres(directUrl, { max:1, prepare:false, ssl:/^(?:localhost|127\.0\.0\.1)$/u.test(directHost)?false:"require", connect_timeout:15, idle_timeout:5 });
try {
  await sql`CREATE TABLE IF NOT EXISTS pms_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const migrationsDirectory=path.join(root,"supabase","migrations");
  const migrations=(await readdir(migrationsDirectory)).filter((name)=>/^\d+_.+\.sql$/u.test(name)).sort();
  const migrationMax=process.env.PMS_MIGRATION_MAX || "";
  for(const migrationFile of migrations){
    const migrationId=migrationFile.replace(/\.sql$/u,"");
    if(migrationMax&&migrationId.localeCompare(migrationMax,"en")>0){
      console.log(`Deferred migration ${migrationId} after ${migrationMax}.`);
      continue;
    }
    const applied = await sql`SELECT id FROM pms_schema_migrations WHERE id=${migrationId}`;
    if (!applied.length) {
      const migration = await readFile(path.join(migrationsDirectory,migrationFile),"utf8");
      await sql.unsafe(migration);
      console.log(`Applied migration ${migrationId}.`);
    } else {
      console.log(`Migration ${migrationId} already applied.`);
    }
  }

  const seed = await readFile(path.join(root,"supabase","seed.sql"),"utf8");
  await sql.unsafe(seed);

  const [summary] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') table_count,
      -- Supabase-managed schemas can add or remove platform triggers independently
      -- of Talos releases, so readiness reports only application-owned triggers.
      (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public') trigger_count,
      (SELECT COUNT(*)::int FROM properties) property_count,
      (SELECT COUNT(*)::int FROM room_types) room_type_count,
      (SELECT COUNT(*)::int FROM rooms) room_count,
      (SELECT COUNT(*)::int FROM reservations) reservation_count
  `;
  console.log(`Supabase ready: ${summary.table_count} tables, ${summary.trigger_count} triggers, ${summary.property_count} property, ${summary.room_type_count} room types, ${summary.room_count} rooms, ${summary.reservation_count} reservations.`);
} finally {
  await sql.end({timeout:5});
}
