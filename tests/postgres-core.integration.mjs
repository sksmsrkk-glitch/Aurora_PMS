/** Integration tests executed against the exact migrated PostgreSQL schema. */
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { consumeRateLimit } from "../app/api/rate-limit.ts";
import { snapshot } from "../app/api/pms/read-model.ts";
import { closePmsDatabase, getPmsDatabase, scopePmsDatabase } from "../db/pms-database.ts";

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

test("operational dates and timestamps use native PostgreSQL types", { skip }, async () => {
  const sql = client(1);
  try {
    const [types] = await sql`
      SELECT
        COUNT(*) FILTER (
          WHERE data_type='text'
            AND (column_name LIKE '%\\_date' ESCAPE '\\' OR column_name LIKE '%\\_at' ESCAPE '\\' OR column_name IN ('window_start','eta','checkin_time','checkout_time'))
        )::int textual_temporal,
        COUNT(*) FILTER (WHERE data_type='date')::int date_columns,
        COUNT(*) FILTER (WHERE data_type='timestamp with time zone')::int timestamp_columns,
        COUNT(*) FILTER (WHERE data_type='time without time zone')::int time_columns
      FROM information_schema.columns
      WHERE table_schema='public'
    `;
    assert.equal(types.textual_temporal, 0);
    assert.ok(types.date_columns >= 28);
    assert.ok(types.timestamp_columns >= 66);
    assert.ok(types.time_columns >= 3);
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("flags and structured payloads use native types with reservation invariants", { skip }, async () => {
  const sql = client(1);
  try {
    const [types] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE data_type='boolean')::int boolean_columns,
        COUNT(*) FILTER (WHERE data_type='jsonb')::int jsonb_columns,
        COUNT(*) FILTER (
          WHERE data_type='integer' AND column_name IN (
            'active','published','closed','close_to_arrival',
            'close_to_departure','website_closed','deduct_inventory'
          )
        )::int legacy_integer_flags
      FROM information_schema.columns
      WHERE table_schema='public'
    `;
    assert.ok(types.boolean_columns >= 24);
    assert.ok(types.jsonb_columns >= 12);
    assert.equal(types.legacy_integer_flags, 0);

    const [constraints] = await sql`
      SELECT COUNT(*)::int count
      FROM pg_constraint
      WHERE connamespace='public'::regnamespace AND convalidated
        AND conname IN (
          'reservations_stay_range_check','reservations_occupancy_check',
          'reservations_nightly_rate_check','reservations_version_check',
          'reservations_status_check','guests_preferences_array',
          'rooms_features_array','room_type_amenities_array'
        )
    `;
    assert.equal(constraints.count, 8);
    const [reservation] = await sql`SELECT id FROM reservations ORDER BY id LIMIT 1`;
    const [guest] = await sql`SELECT id FROM guests ORDER BY id LIMIT 1`;
    assert.ok(reservation?.id && guest?.id, "seed must include a reservation and guest");
    await assert.rejects(
      sql`UPDATE reservations SET departure_date=arrival_date WHERE id=${reservation.id}`,
      (error) => error?.code === "23514" && /reservations_stay_range_check/u.test(error.message),
    );
    await assert.rejects(
      sql`UPDATE guests SET preferences='{}'::jsonb WHERE id=${guest.id}`,
      (error) => error?.code === "23514" && /guests_preferences_array/u.test(error.message),
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("staff assignments store complete page permissions and remain tenant isolated", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),propertyId=`it-staff-${suffix}`,assignmentId=`it-role-${suffix}`;
  try{
    await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date) VALUES (${propertyId},'Staff Hotel',${`S-${suffix}`},'Asia/Seoul','KRW','2031-01-01')`;
    const permissions={overview:"READ",frontdesk:"WRITE",inventory:"NONE",website:"NONE",groups:"NONE",finance:"NONE",accounting:"NONE",channels:"NONE",rooms:"READ",reports:"READ",master:"NONE",revenue:"NONE",users:"NONE",audit:"NONE"};
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},${propertyId},${`staff-${suffix}@example.com`},'FRONT_DESK',true,now(),'Integration Staff',${sql.json(permissions)},true,now())`;
    const [stored]=await sql`SELECT display_name,workspace_permissions,can_export,version FROM role_assignments WHERE id=${assignmentId}`;
    assert.equal(stored.display_name,"Integration Staff");
    assert.deepEqual(stored.workspace_permissions,permissions);
    assert.equal(stored.can_export,true);
    await assert.rejects(sql`UPDATE role_assignments SET workspace_permissions='{"overview":"OWNER"}'::jsonb WHERE id=${assignmentId}`,(error)=>error?.code==="23514");
    const visible=await sql.begin(async(tx)=>{await tx.unsafe("SET LOCAL ROLE aurora_app");await tx`SELECT set_config('app.property_id',${propertyId},true)`;return tx`SELECT id FROM role_assignments ORDER BY id`;});
    assert.deepEqual(visible.map((row)=>row.id),[assignmentId]);
  }finally{await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;await sql`DELETE FROM properties WHERE id=${propertyId}`;await sql.end({timeout:2});}
});

test("dashboard comparisons match current and prior business-day facts", { skip }, async () => {
  const sql = client(1);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    const [expected] = await sql`
      WITH context AS (
        SELECT business_date current_day, business_date - 1 prior_day
        FROM properties WHERE id='prop-seoul'
      )
      SELECT
        (SELECT COUNT(*)::int FROM reservations r,context c
          WHERE r.property_id='prop-seoul' AND r.arrival_date=c.current_day
            AND r.status NOT IN ('CANCELLED','NO_SHOW')) current_arrivals,
        (SELECT COUNT(*)::int FROM reservations r,context c
          WHERE r.property_id='prop-seoul' AND r.arrival_date<=c.current_day
            AND r.departure_date>c.current_day
            AND r.status NOT IN ('CANCELLED','NO_SHOW')) current_occupied,
        (SELECT COUNT(*)::int FROM reservations r,context c
          WHERE r.property_id='prop-seoul' AND r.arrival_date=c.prior_day
            AND r.status NOT IN ('CANCELLED','NO_SHOW')) prior_arrivals
    `;
    process.env.DATABASE_URL = databaseUrl;
    const db = scopePmsDatabase(getPmsDatabase({ DATABASE_URL: databaseUrl }), "prop-seoul");
    const model = await snapshot(db);
    assert.equal(model.metrics.comparison.current.arrivals, expected.current_arrivals);
    assert.equal(model.metrics.comparison.current.occupied, expected.current_occupied);
    assert.equal(model.metrics.comparison.prior.arrivals, expected.prior_arrivals);
    assert.equal(model.metrics.occupied, model.metrics.comparison.current.occupied);
    assert.ok(Number.isFinite(model.metrics.comparison.current.revenue));
    assert.ok(Number.isFinite(model.metrics.comparison.occupancyChangePoints));
  } finally {
    await closePmsDatabase();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await sql.end({ timeout: 2 });
  }
});

test("rate plans are relational and drive direct-booking nightly prices", { skip }, async () => {
  const sql = client(2);
  const stayDate = "2031-09-01";
  const departure = "2031-09-02";
  const rate = 345678;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    const [plan] = await sql`SELECT id FROM rate_plans WHERE property_id='prop-seoul' AND code='WEB-DIRECT'`;
    assert.ok(plan?.id);
    await sql`
      INSERT INTO rate_plan_calendar(
        id,property_id,rate_plan_id,room_type_id,stay_date,sell_rate,closed,
        min_stay,close_to_arrival,close_to_departure,version,updated_at,updated_by
      ) VALUES (
        ${`it-rate-${crypto.randomUUID()}`},'prop-seoul',${plan.id},'rt-dlx',
        ${stayDate},${rate},false,1,false,false,1,now(),'integration-test'
      )
      ON CONFLICT(property_id,rate_plan_id,room_type_id,stay_date)
      DO UPDATE SET sell_rate=excluded.sell_rate,closed=false,updated_at=now(),updated_by='integration-test'
    `;
    process.env.DATABASE_URL = databaseUrl;
    const { getAvailability } = await import("../app/api/booking/service.ts");
    const availability = await getAvailability({ arrival: stayDate, departure, adults: 2, children: 0 });
    const offer = availability.offers.find((item) => item.roomTypeId === "rt-dlx");
    assert.equal(offer?.nights[0].rate, rate);
    const [constraints] = await sql`
      SELECT COUNT(*)::int count FROM pg_constraint
      WHERE connamespace='public'::regnamespace AND convalidated
        AND conname IN ('reservation_rate_plan_fk','reservation_rate_night_plan_fk','channel_mapping_rate_plan_fk')
    `;
    assert.equal(constraints.count, 3);
  } finally {
    await sql`DELETE FROM rate_plan_calendar WHERE property_id='prop-seoul' AND stay_date=${stayDate} AND updated_by='integration-test'`;
    await closePmsDatabase();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
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
      INSERT INTO rate_plans(
        id,property_id,code,name,currency,created_at,updated_at,created_by,updated_by
      ) VALUES (
        ${`it-plan-${suffix}`},${propertyId},'BAR','Concurrency BAR','KRW',
        now(),now(),'integration-test','integration-test'
      )
    `;
    await sql`
      INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status)
      VALUES (${`it-room-${suffix}`},${propertyId},${roomTypeId},'101',1,'VACANT','CLEAN')
    `;
    for (const item of reservations) {
      await sql`
        INSERT INTO guests(id,property_id,first_name,last_name,created_at)
        VALUES (${item.guestId},${propertyId},'Parallel',${item.id},now())
      `;
      await sql`
        INSERT INTO reservations(
          id,confirmation_no,property_id,guest_id,room_type_id,arrival_date,
          departure_date,status,adults,source,rate_plan,nightly_rate,created_at,updated_at
        ) VALUES (
          ${item.id},${item.confirmation},${propertyId},${item.guestId},${roomTypeId},
          ${stayDate},'2031-08-02','DUE_IN',1,'TEST','BAR',100000,now(),now()
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
