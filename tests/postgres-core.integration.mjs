/** Integration tests executed against the exact migrated PostgreSQL schema. */
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { consumeRateLimit } from "../app/api/rate-limit.ts";
import { closePmsDatabase, getPmsDatabase } from "../db/pms-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "";
const required = process.env.AURORA_REQUIRE_POSTGRES_TESTS === "true";
if (required && !databaseUrl) {
  throw new Error("AURORA_REQUIRE_POSTGRES_TESTS requires TEST_DATABASE_URL");
}
const skip = !databaseUrl;

function client(max = 10) {
  return postgres(databaseUrl, {
    max,
    prepare: false,
    ssl: false,
    idle_timeout: 2,
  });
}

test("migrated schema contains booking tables and no arbitrary SQL RPC", { skip }, async () => {
  const sql = client(1);
  try {
    const [surface] = await sql`
      SELECT
        to_regclass('public.booking_requests')::text booking_requests,
        to_regclass('public.reservation_rate_nights')::text reservation_rate_nights,
        to_regprocedure('public.pms_execute(text,jsonb)')::text pms_execute,
        to_regprocedure('public.pms_batch(jsonb)')::text pms_batch
    `;
    assert.equal(surface.booking_requests, "booking_requests");
    assert.equal(surface.reservation_rate_nights, "reservation_rate_nights");
    assert.equal(surface.pms_execute, null);
    assert.equal(surface.pms_batch, null);
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("RLS tenant context hides and rejects cross-property access", { skip }, async () => {
  const sql = client(2);
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = `it-a-${suffix}`;
  const second = `it-b-${suffix}`;
  try {
    await sql`
      INSERT INTO properties(id,name,code,timezone,currency,business_date)
      VALUES
        (${first},'Tenant A',${`A-${suffix}`},'Asia/Seoul','KRW','2026-08-01'),
        (${second},'Tenant B',${`B-${suffix}`},'Asia/Seoul','KRW','2026-08-01')
    `;
    const visible = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE aurora_app");
      await tx`SELECT set_config('app.property_id',${first},true)`;
      return tx`SELECT id FROM properties ORDER BY id`;
    });
    assert.deepEqual(visible.map((row) => row.id), [first]);
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE aurora_app");
        await tx`SELECT set_config('app.property_id',${first},true)`;
        await tx`
          INSERT INTO room_types(id,property_id,code,name,base_rate,capacity)
          VALUES (${`rt-cross-${suffix}`},${second},'CROSS','Cross Tenant',1,1)
        `;
      }),
      (error) => error?.code === "42501",
    );
  } finally {
    await sql`DELETE FROM properties WHERE id IN (${first},${second})`;
    await sql.end({ timeout: 2 });
  }
});

test("distributed rate limit admits exactly the configured concurrent quota", { skip }, async () => {
  const previousSecret = process.env.PMS_RATE_LIMIT_SECRET;
  process.env.PMS_RATE_LIMIT_SECRET =
    "integration-rate-limit-secret-with-32-characters";
  const scope = `it-${crypto.randomUUID()}`;
  const request = new Request("https://pms.example/api/pms");
  const db = getPmsDatabase({ DATABASE_URL: databaseUrl });
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeRateLimit(request, scope, 5, 60_000, "same-identity", db),
      ),
    );
    assert.equal(results.filter((result) => result.allowed).length, 5);
    assert.equal(Math.max(...results.map((result) => result.remaining)), 4);
    assert.equal(Math.min(...results.map((result) => result.remaining)), 0);
  } finally {
    await closePmsDatabase();
    if (previousSecret === undefined) delete process.env.PMS_RATE_LIMIT_SECRET;
    else process.env.PMS_RATE_LIMIT_SECRET = previousSecret;
  }
});

test("append-only folio trigger rejects updates in the production schema", { skip }, async () => {
  const sql = client(1);
  try {
    const [entry] = await sql`SELECT id FROM folio_entries ORDER BY id LIMIT 1`;
    assert.ok(entry?.id, "seed must include a folio entry");
    await assert.rejects(
      sql`UPDATE folio_entries SET amount=amount WHERE id=${entry.id}`,
      /immutable/iu,
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("twenty parallel bookings for the last room allow exactly one night", { skip }, async () => {
  const sql = client(24);
  const suffix = crypto.randomUUID().slice(0, 8);
  const propertyId = `it-cap-${suffix}`;
  const roomTypeId = `it-rt-${suffix}`;
  const stayDate = "2031-08-01";
  const reservations = Array.from({ length: 20 }, (_, index) => ({
    id: `it-res-${suffix}-${index}`,
    guestId: `it-guest-${suffix}-${index}`,
    confirmation: `IT-${suffix}-${index}`,
  }));
  try {
    await sql`
      INSERT INTO properties(id,name,code,timezone,currency,business_date)
      VALUES (${propertyId},'Concurrency Hotel',${`C-${suffix}`},'Asia/Seoul','KRW','2031-07-31')
    `;
    await sql`
      INSERT INTO room_types(id,property_id,code,name,base_rate,capacity)
      VALUES (${roomTypeId},${propertyId},'LAST','Last Room',100000,2)
    `;
    await sql`
      INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status)
      VALUES (${`it-room-${suffix}`},${propertyId},${roomTypeId},'101',1,'VACANT','CLEAN')
    `;
    for (const item of reservations) {
      await sql`
        INSERT INTO guests(id,property_id,first_name,last_name,created_at)
        VALUES (${item.guestId},${propertyId},'Parallel',${item.id},now()::text)
      `;
      await sql`
        INSERT INTO reservations(
          id,confirmation_no,property_id,guest_id,room_type_id,arrival_date,
          departure_date,status,adults,source,rate_plan,nightly_rate,created_at,updated_at
        ) VALUES (
          ${item.id},${item.confirmation},${propertyId},${item.guestId},${roomTypeId},
          ${stayDate},'2031-08-02','DUE_IN',1,'TEST','BAR',100000,now()::text,now()::text
        )
      `;
    }
    const attempts = await Promise.allSettled(
      reservations.map((item) =>
        sql`
          INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date)
          VALUES (${propertyId},${item.id},${roomTypeId},${stayDate})
        `,
      ),
    );
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 19);
    assert.ok(
      rejected.every((result) => /room type sold out/iu.test(String(result.reason))),
    );
    const [count] = await sql`
      SELECT COUNT(*)::int count
      FROM reservation_type_nights
      WHERE property_id=${propertyId} AND room_type_id=${roomTypeId} AND stay_date=${stayDate}
    `;
    assert.equal(count.count, 1);
  } finally {
    await sql`DELETE FROM reservation_type_nights WHERE property_id=${propertyId}`;
    await sql`DELETE FROM reservations WHERE property_id=${propertyId}`;
    await sql`DELETE FROM guests WHERE property_id=${propertyId}`;
    await sql`DELETE FROM rooms WHERE property_id=${propertyId}`;
    await sql`DELETE FROM room_types WHERE property_id=${propertyId}`;
    await sql`DELETE FROM properties WHERE id=${propertyId}`;
    await sql.end({ timeout: 2 });
  }
});
