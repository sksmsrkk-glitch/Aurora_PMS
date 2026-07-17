/** Regression gates for the seven findings fixed in the July security review. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("runtime and seed paths never provision an administrator",async()=>{
  const [route,seed,legacyIdentity,removal]=await Promise.all([read("app/api/pms/route.ts"),read("supabase/seed.sql"),read("supabase/migrations/202607170006_default_admin_identity.sql"),read("supabase/migrations/202607170007_remove_seed_admin.sql")]);
  assert.doesNotMatch(route,/INSERT[^\n]+role_assignments/iu);
  assert.doesNotMatch(seed,/role_assignments/iu);
  assert.doesNotMatch(legacyIdentity,/INSERT INTO public\.role_assignments/iu);
  assert.doesNotMatch(legacyIdentity,/pms@allmytour\.com|frontdesk@aurora\.hotel/iu);
  assert.match(removal,/DELETE FROM public\.role_assignments/iu);
  assert.match(removal,/role-local-pms-admin/iu);
});

test("clean Supabase seed projects website CMS rows after schema migrations",async()=>{
  const [seed,smoke]=await Promise.all([read("supabase/seed.sql"),read("scripts/smoke-supabase.mjs")]);
  assert.match(seed,/INSERT INTO website_settings/iu);
  assert.match(seed,/INSERT INTO room_type_website/iu);
  assert.match(seed,/INSERT INTO accounting_accounts/iu);
  assert.match(seed,/ON CONFLICT \(property_id,room_type_id\) DO NOTHING/iu);
  assert.match(smoke,/n\.nspname='public'/u);
  assert.match(smoke,/required_triggers/u);
});

test("demo authentication is non-production, explicit, token-bound, and host-independent",async()=>{
  const route=await read("app/api/pms/route.ts");
  assert.match(route,/process\.env\.NODE_ENV === "production"/u);
  assert.match(route,/PMS_ALLOW_DEMO_AUTH !== "true"/u);
  assert.match(route,/PMS_DEMO_AUTH_TOKEN/gu);
  assert.match(route,/timingSafeEqual/gu);
  assert.doesNotMatch(route,/localRequest|\["localhost",\s*"127\.0\.0\.1"\]/u);
});

test("every folio and AR command commits a strict idempotency receipt",async()=>{
  const [route,extended]=await Promise.all([read("app/api/pms/route.ts"),read("app/api/pms/extended.ts")]);
  const actions=["create_folio_window","create_routing_rule","split_folio_entry","reverse_folio_entry","refund_payment","transfer_to_ar","post_ar_payment"];
  for(let index=0;index<actions.length;index+=1){
    const start=route.indexOf(`body.action === "${actions[index]}"`);
    const end=index+1<actions.length?route.indexOf(`body.action === "${actions[index+1]}"`,start):route.indexOf('body.action === "housekeeping"',start);
    assert.ok(start>=0&&end>start,`${actions[index]} branch missing`);
    assert.match(route.slice(start,end),/mutationReceipt\(\)/u,`${actions[index]} does not commit its receipt`);
  }
  assert.match(route,/INSERT INTO idempotency_keys/gu);
  assert.doesNotMatch(extended,/INSERT OR IGNORE INTO idempotency_keys/u);
});

test("arbitrary SQL RPC bridge is absent from runtime and revoked by migration",async()=>{
  const [database,removal]=await Promise.all([read("db/pms-database.ts"),read("supabase/migrations/202607170009_remove_arbitrary_sql_rpc.sql")]);
  assert.doesNotMatch(database,/pms_execute|pms_batch|SupabaseHttpDatabase/u);
  assert.match(database,/DATABASE_URL/gu);
  assert.match(removal,/REVOKE ALL ON FUNCTION public\.pms_execute/u);
  assert.match(removal,/DROP FUNCTION IF EXISTS public\.pms_batch/u);
  assert.match(removal,/service_role/u);
});

test("Supabase migrations are the only schema source",async()=>{
  const [route,database,packageJson]=await Promise.all([read("app/api/pms/route.ts"),read("db/pms-database.ts"),read("package.json")]);
  assert.doesNotMatch(route,/CREATE TABLE|CREATE TRIGGER|PRAGMA table_info/u);
  assert.doesNotMatch(database,/toPostgresSql|D1Database|INSERT OR IGNORE/u);
  assert.doesNotMatch(packageJson,/drizzle|supabase:generate|db:generate/u);
  await assert.rejects(read("db/schema.ts"),/ENOENT/u);
  await assert.rejects(read("scripts/generate-supabase-migration.mjs"),/ENOENT/u);
});

test("stateful QA proves staging deployment and database isolation before writes",async()=>{
  const [gate,workflow,booking,cms]=await Promise.all([read("scripts/qa-target.mjs"),read("scripts/qa-full-workflow.mjs"),read("scripts/qa-booking-engine.mjs"),read("scripts/qa-website-cms.mjs")]);
  assert.match(gate,/AURORA_STAGING_ONLY/u);
  assert.match(gate,/databaseProjectRef!==expectedProjectRef/u);
  assert.match(gate,/tnbxreeidezidckemflb/u);
  assert.match(gate,/qaAllowed!==true/u);
  for(const source of [workflow,booking,cms])assert.match(source,/assertSafeQaTarget/u);
});

test("login, booking, and PMS writes use a shared atomic database rate limit",async()=>{
  const [limiter,login,guard,pms,migration]=await Promise.all([read("app/api/rate-limit.ts"),read("app/api/auth/login/route.ts"),read("app/api/booking/guard.ts"),read("app/api/pms/route.ts"),read("supabase/migrations/202607170008_distributed_rate_limits.sql")]);
  assert.match(limiter,/ON CONFLICT\(scope,key_hash,window_start\) DO UPDATE/u);
  assert.match(limiter,/createHmac/u);
  assert.match(limiter,/x-vercel-forwarded-for/u);
  for(const source of [login,guard,pms])assert.match(source,/consumeRateLimit/u);
  assert.doesNotMatch(login,/new Map/u);
  assert.doesNotMatch(guard,/new Map/u);
  assert.match(migration,/PRIMARY KEY\(scope,key_hash,window_start\)/u);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/u);
});

test("night-audit controls stay below the serverless database pool ceiling",async()=>{
  const [route,workflow]=await Promise.all([read("app/api/pms/route.ts"),read("scripts/qa-full-workflow.mjs")]);
  const start=route.indexOf("async function operationalControls");
  const end=route.indexOf("function datesBetween",start);
  const controls=route.slice(start,end);
  assert.doesNotMatch(controls,/Promise\.all/u);
  assert.match(controls,/room_postings/u);
  assert.match(workflow,/AbortSignal\.timeout\(90_000\)/u);
  assert.match(workflow,/PMS_TEST_EMAIL\|\|process\.env\.PMS_DEMO_USER_EMAIL/u);
  assert.doesNotMatch(workflow,/q:\s*"pms@allmytour\.com"/u);
});
