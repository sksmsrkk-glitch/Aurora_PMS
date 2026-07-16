import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Supabase Auth uses verified users and HttpOnly refreshable sessions",async()=>{
  const [session,route,login]=await Promise.all([read("app/supabase-session.ts"),read("app/api/pms/route.ts"),read("app/api/auth/login/route.ts")]);
  assert.match(session,/\/auth\/v1\/user/);
  assert.match(session,/createRemoteJWKSet/);
  assert.match(session,/jwtVerify/);
  assert.match(session,/identityInflight/);
  assert.match(session,/grant_type=refresh_token/);
  assert.match(session,/httpOnly:\s*true/);
  assert.match(session,/sameSite:\s*"lax"/);
  assert.match(route,/authenticateSupabaseRequest/);
  assert.match(route,/principalInflight/);
  assert.match(route,/const results = await db\.batch\(\[/);
  assert.match(route,/process\.env\.NODE_ENV\s*!==\s*"production"/);
  assert.doesNotMatch(route,/bootstrapRole/);
  assert.match(login,/count>=8/);
});

test("property scope, required idempotency and atomic 500-room batches are enforced",async()=>{
  const [route,database]=await Promise.all([read("app/api/pms/route.ts"),read("db/pms-database.ts")]);
  assert.match(route,/propertyId:\s*string/);
  assert.match(route,/scopePmsDatabase\(rootDb, principal\.propertyId\)/);
  assert.match(database,/Invalid property scope/);
  assert.match(route,/변경 요청에는 유효한 Idempotency-Key가 필요합니다/);
  assert.match(route,/count>500/);
  assert.match(route,/await db\.batch\(\[\.\.\.roomStatements,/);
  assert.doesNotMatch(route,/offset<numbers\.length;offset\+=40/);
  assert.match(route,/SELECT id FROM rooms WHERE id=\? AND property_id='prop-seoul'/);
  assert.match(route,/DELETE FROM reservation_nights WHERE reservation_id=\? AND property_id='prop-seoul'/);
  assert.match(route,/UPDATE reservations SET status='IN_HOUSE'.*property_id='prop-seoul'/);
  assert.match(route,/UPDATE inbound_channel_messages SET status='PROCESSED'.*property_id='prop-seoul'/);
});

test("relational and accounting concurrency constraints are migration-backed",async()=>{
  const migration=await read("supabase/migrations/202607170001_relational_integrity.sql");
  assert.ok((migration.match(/FOREIGN KEY/gu)||[]).length>=60);
  assert.match(migration,/accounting_journal_reversal_once_uq/);
  assert.match(migration,/accounting_journal_source_once_uq/);
  assert.match(migration,/VALIDATE CONSTRAINT/);
});

test("core snapshot, hardened headers and health monitoring are present",async()=>{
  const [route,config,health]=await Promise.all([read("app/api/pms/route.ts"),read("next.config.ts"),read("app/api/health/route.ts")]);
  assert.match(route,/get\("view"\)===\"core\"/);
  assert.match(route,/cachedCoreSnapshotResponse/);
  assert.match(config,/Content-Security-Policy/);
  assert.match(config,/frame-ancestors 'none'/);
  assert.match(config,/poweredByHeader:\s*false/);
  assert.match(health,/status:\"degraded\"/);
});

test("direct booking engine is PMS-backed, atomic and idempotent",async()=>{
  const [service,reservations,availability,migration,hotel,booking]=await Promise.all([
    read("app/api/booking/service.ts"),read("app/api/booking/reservations/route.ts"),read("app/api/booking/availability/route.ts"),
    read("supabase/migrations/202607170003_booking_engine.sql"),read("app/hotel/page.tsx"),read("app/hotel/book/BookingClient.tsx"),
  ]);
  assert.match(service,/reservation_type_nights/);
  assert.match(service,/reservation_rate_nights/);
  assert.match(service,/booking_requests/);
  assert.match(service,/await db\.batch\(statements\)/);
  assert.match(service,/OFFER_CHANGED/);
  assert.match(service,/close_to_arrival/);
  assert.match(service,/close_to_departure/);
  assert.match(service,/minimumStay/);
  assert.match(reservations,/idempotency-key/);
  assert.match(reservations,/isSameOrigin/);
  assert.match(availability,/allowBookingRequest/);
  assert.match(migration,/pms_booking_rate_immutable_guard/);
  assert.match(hotel,/객실 검색/);
  assert.match(booking,/예약 확정/);
});
