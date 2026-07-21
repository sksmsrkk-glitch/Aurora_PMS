/** Integration tests executed against the exact migrated PostgreSQL schema. */
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { consumeRateLimit } from "../app/api/rate-limit.ts";
import { loadPmsSearch, loadReservationAvailability, loadReservationCalendar, loadReservationDetail } from "../app/api/pms/frontdesk-read.ts";
import { snapshot } from "../app/api/pms/read-model.ts";
import { handlePmsPost } from "../app/api/pms/command-gateway.ts";
import { runReport } from "../app/api/pms/reporting.ts";
import { loadChannelCatalog, loadOperationalCatalogs, loadRateBlockMatrix } from "../app/api/pms/hotelstory-catalog-service.ts";
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
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),propertyId=`it-staff-${suffix}`,organizationId=`org-${propertyId}`,assignmentId=`it-role-${suffix}`;
  try{
    await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Staff Organization',${`staff-${suffix}`},'ACTIVE')`;
    await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug) VALUES (${propertyId},'Staff Hotel',${`S-${suffix}`},'Asia/Seoul','KRW','2031-01-01',${organizationId},${`staff-hotel-${suffix}`})`;
    const permissions={overview:"READ",frontdesk:"WRITE",inventory:"NONE",website:"NONE",groups:"NONE",finance:"NONE",accounting:"NONE",channels:"NONE",rooms:"READ",reports:"READ",master:"NONE",revenue:"NONE",users:"NONE",audit:"NONE"};
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},${propertyId},${`staff-${suffix}@example.com`},'FRONT_DESK',true,now(),'Integration Staff',${sql.json(permissions)},true,now())`;
    const [stored]=await sql`SELECT display_name,workspace_permissions,can_export,version FROM role_assignments WHERE id=${assignmentId}`;
    assert.equal(stored.display_name,"Integration Staff");
    assert.deepEqual(stored.workspace_permissions,permissions);
    assert.equal(stored.can_export,true);
    await assert.rejects(sql`UPDATE role_assignments SET workspace_permissions='{"overview":"OWNER"}'::jsonb WHERE id=${assignmentId}`,(error)=>error?.code==="23514");
    const visible=await sql.begin(async(tx)=>{await tx.unsafe("SET LOCAL ROLE aurora_app");await tx`SELECT set_config('app.property_id',${propertyId},true)`;return tx`SELECT id FROM role_assignments ORDER BY id`;});
    assert.deepEqual(visible.map((row)=>row.id),[assignmentId]);
  }finally{await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;await sql`DELETE FROM properties WHERE id=${propertyId}`;await sql`DELETE FROM organizations WHERE id=${organizationId}`;await sql.end({timeout:2});}
});

test("production authorization binds a staff assignment to the immutable Auth user ID", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),linkedProperty=`it-linked-${suffix}`,legacyProperty=`it-legacy-${suffix}`,organizationId=`org-identity-${suffix}`;
  const email=`identity-${suffix}@example.com`,authUserId=crypto.randomUUID();
  const permissions={overview:"READ",frontdesk:"NONE",inventory:"NONE",website:"NONE",groups:"NONE",finance:"NONE",accounting:"NONE",channels:"NONE",rooms:"READ",reports:"NONE",master:"NONE",revenue:"NONE",users:"NONE",audit:"NONE"};
  const database=getPmsDatabase({DATABASE_URL:databaseUrl});
  try{
    await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Identity Organization',${`identity-${suffix}`},'ACTIVE')`;
    await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug) VALUES (${linkedProperty},'Linked Hotel',${`L-${suffix}`},'Asia/Seoul','KRW','2031-01-01',${organizationId},${`linked-${suffix}`}),(${legacyProperty},'Legacy Hotel',${`U-${suffix}`},'Asia/Seoul','KRW','2031-01-01',${organizationId},${`legacy-${suffix}`})`;
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,auth_user_id,display_name,workspace_permissions,can_export,updated_at) VALUES (${`it-linked-role-${suffix}`},${linkedProperty},${email},'VIEWER',true,now(),${authUserId},'Linked Staff',${sql.json(permissions)},false,now()),(${`it-legacy-role-${suffix}`},${legacyProperty},${email},'PROPERTY_ADMIN',true,now(),NULL,'Legacy Staff',${sql.json(permissions)},false,now())`;
    const linked=await database.findActiveRoleAssignments(authUserId,email);
    assert.deepEqual(linked.map((item)=>item.property_id),[linkedProperty]);
    assert.deepEqual(await database.findActiveRoleAssignments(crypto.randomUUID(),email),[]);
  }finally{
    await closePmsDatabase();
    await sql`DELETE FROM role_assignments WHERE property_id IN (${linkedProperty},${legacyProperty})`;
    await sql`DELETE FROM properties WHERE id IN (${linkedProperty},${legacyProperty})`;
    await sql`DELETE FROM organizations WHERE id=${organizationId}`;
    await sql.end({timeout:2});
  }
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
          WHERE r.property_id='prop-seoul' AND r.arrival_date=c.current_day
            AND r.status IN ('IN_HOUSE','CHECKED_OUT')) current_processed_arrivals,
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
    assert.equal(model.metrics.comparison.current.processedArrivals, expected.current_processed_arrivals);
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

test("global PMS search executes every permitted domain query on the production schema", { skip }, async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = databaseUrl;
    const db = scopePmsDatabase(getPmsDatabase({ DATABASE_URL: databaseUrl }), "prop-seoul");
    const result = await loadPmsSearch(db, new URLSearchParams({ q: "Sofia" }), {
      workspaceAccess: { frontdesk: "READ", rooms: "READ", finance: "READ" },
      piiMode: "FULL",
    });
    assert.ok(result.total >= 1);
    assert.ok(result.groups.some((group) => group.id === "reservations" && group.items.some((item) => item.title.includes("Sofia"))));
  } finally {
    await closePmsDatabase();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
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

test("reservation List and Calendar share product and occupancy pricing", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),planId=`it-calendar-plan-${suffix}`;
  const database=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul");
  try{
    await sql`
      INSERT INTO rate_plans(
        id,property_id,code,name,currency,meal_plan,package_type,inclusions,
        base_occupancy,max_occupancy,pricing_model,adjustment,sort_order,
        created_at,updated_at,created_by,updated_by
      ) VALUES (
        ${planId},'prop-seoul',${`ITCAL-${suffix.toUpperCase()}`},'Calendar Full Package','KRW','FULL_PACKAGE','HOMESHOPPING',
        ${sql.json(["breakfast","dinner"])},2,4,'FIXED',0,1,now(),now(),'integration-test','integration-test'
      )
    `;
    await sql`INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by) VALUES ('prop-seoul',${planId},'rt-ste',250000,true,1,now(),'integration-test')`;
    await sql`INSERT INTO rate_plan_occupancy(property_id,rate_plan_id,occupancy,extra_charge,updated_by) VALUES ('prop-seoul',${planId},3,30000,'integration-test')`;
    const list=await loadReservationAvailability(database,new URLSearchParams({arrival:"2031-11-10",departure:"2031-11-12",adults:"3",children:"0"}));
    const suite=list.offers.find(item=>item.roomTypeId==="rt-ste"),product=suite?.plans.find(item=>item.id===planId);
    assert.equal(product?.mealPlan,"FULL_PACKAGE");
    assert.equal(product?.baseOccupancy,2);
    assert.equal(product?.maxOccupancy,4);
    assert.equal(product?.total,560000);
    const calendar=await loadReservationCalendar(database,new URLSearchParams({month:"2031-11",ratePlanId:planId,adults:"3",children:"0"}));
    assert.equal(calendar.dates.length,30);
    assert.equal(calendar.selectedProduct?.id,planId);
    const day=calendar.rows.find(item=>item.roomTypeId==="rt-ste")?.cells.find(item=>item.date==="2031-11-10");
    assert.deepEqual(day,{date:"2031-11-10",available:1,total:1,rate:280000,closed:false});
  }finally{
    await closePmsDatabase();
    await sql`DELETE FROM rate_plan_occupancy WHERE property_id='prop-seoul' AND rate_plan_id=${planId}`;
    await sql`DELETE FROM rate_plan_room_types WHERE property_id='prop-seoul' AND rate_plan_id=${planId}`;
    await sql`DELETE FROM rate_plans WHERE property_id='prop-seoul' AND id=${planId}`;
    await sql.end({timeout:2});
  }
});

test("sale products inherit rates, price occupancy, and preserve reservation snapshots", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8);
  const organizationId=`org-product-${suffix}`,propertyId=`it-product-${suffix}`;
  const roomTypeId=`it-product-room-${suffix}`,parentId=`it-parent-${suffix}`,childId=`it-child-${suffix}`;
  const guestId=`it-product-guest-${suffix}`,reservationId=`it-product-res-${suffix}`;
  try {
    await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Product Organization',${`product-${suffix}`},'ACTIVE')`;
    await sql`INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug) VALUES (${propertyId},'Product Hotel',${`P-${suffix}`},'Asia/Seoul','KRW','2031-09-01',${organizationId},${`product-hotel-${suffix}`})`;
    await sql`INSERT INTO room_types(id,property_id,code,name,base_rate,capacity) VALUES (${roomTypeId},${propertyId},'PKG','Package Room',100000,4)`;
    await sql`
      INSERT INTO rate_plans(
        id,property_id,code,name,currency,meal_plan,package_type,inclusions,
        base_occupancy,max_occupancy,pricing_model,adjustment,
        created_at,updated_at,created_by,updated_by
      ) VALUES
        (${parentId},${propertyId},'PARENT','Parent BAR','KRW','ROOM_ONLY','NONE','[]'::jsonb,2,4,'FIXED',0,now(),now(),'integration-test','integration-test'),
        (${childId},${propertyId},'FULLPKG','24-hour Full Package','KRW','FULL_PACKAGE','HOMESHOPPING',${sql.json(["breakfast","dinner","spa"])},2,4,'OFFSET',10000,now(),now(),'integration-test','integration-test')
    `;
    await sql`UPDATE rate_plans SET parent_rate_plan_id=${parentId} WHERE id=${childId}`;
    await sql`
      INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by)
      VALUES
        (${propertyId},${parentId},${roomTypeId},100000,true,1,now(),'integration-test'),
        (${propertyId},${childId},${roomTypeId},1,true,1,now(),'integration-test')
    `;
    await sql`INSERT INTO rate_plan_occupancy(property_id,rate_plan_id,occupancy,extra_charge,updated_by) VALUES (${propertyId},${childId},3,30000,'integration-test')`;
    const [priced]=await sql`SELECT talos_effective_product_rate(${propertyId},${childId},${roomTypeId},'2031-09-02',3)::numeric rate`;
    assert.equal(Number(priced.rate),140000);
    const [invalidParty]=await sql`SELECT talos_effective_product_rate(${propertyId},${childId},${roomTypeId},'2031-09-02',5)::numeric rate`;
    assert.equal(invalidParty.rate,null);
    await sql`UPDATE rate_plan_room_types SET base_rate=200000 WHERE property_id=${propertyId} AND rate_plan_id=${parentId} AND room_type_id=${roomTypeId}`;
    const [repriced]=await sql`SELECT talos_effective_product_rate(${propertyId},${childId},${roomTypeId},'2031-09-02',3)::numeric rate`;
    assert.equal(Number(repriced.rate),240000);
    await sql`INSERT INTO rate_plan_calendar(id,property_id,rate_plan_id,room_type_id,stay_date,sell_rate,updated_at,updated_by) VALUES (${`it-child-date-${suffix}`},${propertyId},${childId},${roomTypeId},'2031-09-02',175000,now(),'integration-test')`;
    const [overridden]=await sql`SELECT talos_effective_product_rate(${propertyId},${childId},${roomTypeId},'2031-09-02',3)::numeric rate`;
    assert.equal(Number(overridden.rate),205000);

    await sql`INSERT INTO guests(id,property_id,first_name,last_name,created_at) VALUES (${guestId},${propertyId},'Product','Guest',now())`;
    await sql`
      INSERT INTO reservations(
        id,confirmation_no,property_id,guest_id,room_type_id,arrival_date,departure_date,
        status,adults,children,source,rate_plan,rate_plan_id,nightly_rate,created_at,updated_at
      ) VALUES (
        ${reservationId},${`IT-P-${suffix}`},${propertyId},${guestId},${roomTypeId},'2031-09-02','2031-09-03',
        'DUE_IN',2,1,'TEST','FULLPKG',${childId},240000,now(),now()
      )
    `;
    const [snapshotBefore]=await sql`SELECT rate_plan_snapshot,occupancy_detail FROM reservations WHERE id=${reservationId}`;
    assert.equal(snapshotBefore.rate_plan_snapshot.name,"24-hour Full Package");
    assert.deepEqual(snapshotBefore.rate_plan_snapshot.inclusions,["breakfast","dinner","spa"]);
    assert.deepEqual(snapshotBefore.occupancy_detail,{adults:2,children:1});
    await sql`UPDATE rate_plans SET name='Changed Product Name' WHERE id=${childId}`;
    const [snapshotAfter]=await sql`SELECT rate_plan_snapshot FROM reservations WHERE id=${reservationId}`;
    assert.equal(snapshotAfter.rate_plan_snapshot.name,"24-hour Full Package");

    const visible=await sql.begin(async(tx)=>{
      await tx.unsafe("SET LOCAL ROLE aurora_app");
      await tx`SELECT set_config('app.property_id',${propertyId},true)`;
      return tx`SELECT rate_plan_id,occupancy,extra_charge FROM rate_plan_occupancy`;
    });
    assert.deepEqual(visible.map(row=>row.rate_plan_id),[childId]);
    const [contract]=await sql`
      SELECT c.udt_name,
        (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.rate_plan_occupancy'::regclass) forced_rls
      FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='rate_plan_occupancy' AND c.column_name='extra_charge'
    `;
    assert.equal(contract.udt_name,"numeric");
    assert.equal(contract.forced_rls,true);
  } finally {
    await sql`DELETE FROM reservations WHERE id=${reservationId}`;
    await sql`DELETE FROM guests WHERE id=${guestId}`;
    await sql`DELETE FROM rate_plan_calendar WHERE property_id=${propertyId}`;
    await sql`DELETE FROM rate_plan_occupancy WHERE property_id=${propertyId}`;
    await sql`DELETE FROM rate_plan_room_types WHERE property_id=${propertyId}`;
    await sql`DELETE FROM rate_plans WHERE property_id=${propertyId}`;
    await sql`DELETE FROM room_types WHERE property_id=${propertyId}`;
    await sql`DELETE FROM properties WHERE id=${propertyId}`;
    await sql`DELETE FROM organizations WHERE id=${organizationId}`;
    await sql.end({timeout:2});
  }
});

test("authenticated reservation command writes product snapshots on the upgraded schema", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),email=`product-command-${suffix}@example.com`;
  const assignmentId=`it-product-command-role-${suffix}`,firstName=`Command${suffix}`;
  const token=`integration-demo-token-${crypto.randomUUID()}`;
  const previous={databaseUrl:process.env.DATABASE_URL,allow:process.env.PMS_ALLOW_DEMO_AUTH,token:process.env.PMS_DEMO_AUTH_TOKEN,email:process.env.PMS_DEMO_USER_EMAIL,rate:process.env.PMS_RATE_LIMIT_SECRET,node:process.env.NODE_ENV};
  const permissions={overview:"WRITE",frontdesk:"WRITE",inventory:"WRITE",website:"WRITE",groups:"WRITE",finance:"WRITE",accounting:"WRITE",channels:"WRITE",rooms:"WRITE",reports:"WRITE",master:"WRITE",revenue:"WRITE",users:"WRITE",audit:"WRITE"};
  try {
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},'prop-seoul',${email},'PROPERTY_ADMIN',true,now(),'Product Command',${sql.json(permissions)},true,now())`;
    process.env.DATABASE_URL=databaseUrl;
    process.env.PMS_ALLOW_DEMO_AUTH="true";
    process.env.PMS_DEMO_AUTH_TOKEN=token;
    process.env.PMS_DEMO_USER_EMAIL=email;
    process.env.PMS_RATE_LIMIT_SECRET=`integration-rate-${crypto.randomUUID()}`;
    process.env.NODE_ENV="test";
    const response=await handlePmsPost(new Request("http://localhost/api/pms",{
      method:"POST",
      headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":`product-command-${suffix}`},
      body:JSON.stringify({action:"create_reservation",firstName,lastName:"Snapshot",arrivalDate:"2031-10-01",departureDate:"2031-10-02",roomTypeId:"rt-dlx",adults:"2",children:"0",ratePlan:"BAR",source:"Integration",nightlyRate:"180000",rateOverride:"false"}),
    }));
    assert.equal(response.status,200,await response.text());
    const [created]=await sql`
      SELECT r.id,r.guest_id,r.rate_plan_id,r.rate_plan_snapshot,r.occupancy_detail
      FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      WHERE r.property_id='prop-seoul' AND g.first_name=${firstName}
    `;
    assert.ok(created?.id);
    assert.equal(created.rate_plan_snapshot.code,"BAR");
    assert.deepEqual(created.occupancy_detail,{adults:2,children:0});
  } finally {
    // The production rate ledger is deliberately immutable. Ephemeral CI cleanup
    // runs as PostgreSQL superuser with triggers disabled only inside this local
    // transaction; application connections can never use this escape hatch.
    await sql.begin(async(tx)=>{
      await tx.unsafe("SET LOCAL session_replication_role='replica'");
      const rows=await tx`SELECT r.id,r.guest_id FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id WHERE r.property_id='prop-seoul' AND g.first_name=${firstName}`;
      for(const row of rows){
        await tx`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id}))`;
        await tx`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id})`;
        await tx`DELETE FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id}`;
        await tx`DELETE FROM reservation_rate_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;
        await tx`DELETE FROM reservation_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;
        await tx`DELETE FROM reservation_type_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;
        await tx`DELETE FROM folio_windows WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;
        await tx`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND entity_id=${row.id}`;
        await tx`DELETE FROM reservations WHERE id=${row.id}`;
        await tx`DELETE FROM guests WHERE id=${row.guest_id}`;
      }
    });
    await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${`product-command-${suffix}`}`;
    await sql`DELETE FROM api_rate_limits WHERE scope='pms-write'`;
    await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;
    await closePmsDatabase();
    for(const [key,value] of Object.entries(previous)){
      const envKey={databaseUrl:"DATABASE_URL",allow:"PMS_ALLOW_DEMO_AUTH",token:"PMS_DEMO_AUTH_TOKEN",email:"PMS_DEMO_USER_EMAIL",rate:"PMS_RATE_LIMIT_SECRET",node:"NODE_ENV"}[key];
      if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;
    }
    await sql.end({timeout:2});
  }
});

test("reservation detail separates booker and guest with optimistic audit history", { skip }, async () => {
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),email=`detail-command-${suffix}@example.com`;
  const assignmentId=`it-detail-role-${suffix}`,token=`integration-detail-token-${crypto.randomUUID()}`;
  const previous={databaseUrl:process.env.DATABASE_URL,allow:process.env.PMS_ALLOW_DEMO_AUTH,token:process.env.PMS_DEMO_AUTH_TOKEN,email:process.env.PMS_DEMO_USER_EMAIL,rate:process.env.PMS_RATE_LIMIT_SECRET,node:process.env.NODE_ENV};
  const permissions={overview:"WRITE",frontdesk:"WRITE",inventory:"WRITE",website:"WRITE",groups:"WRITE",finance:"WRITE",accounting:"WRITE",channels:"WRITE",rooms:"WRITE",reports:"WRITE",master:"WRITE",revenue:"WRITE",users:"WRITE",audit:"WRITE"};
  const firstName=`Stay${suffix}`,secondName=`Link${suffix}`,keys=[];
  const post=async(body,key)=>{keys.push(key);return handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":key},body:JSON.stringify(body)}));};
  try {
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},'prop-seoul',${email},'PROPERTY_ADMIN',true,now(),'Detail Command',${sql.json(permissions)},true,now())`;
    process.env.DATABASE_URL=databaseUrl;process.env.PMS_ALLOW_DEMO_AUTH="true";process.env.PMS_DEMO_AUTH_TOKEN=token;process.env.PMS_DEMO_USER_EMAIL=email;process.env.PMS_RATE_LIMIT_SECRET=`integration-rate-${crypto.randomUUID()}`;process.env.NODE_ENV="test";
    for(const [name,arrival,departure] of [[firstName,"2032-02-10","2032-02-12"],[secondName,"2032-03-10","2032-03-11"]]){
      const response=await post({action:"create_reservation",firstName:name,lastName:"Guest",email:`${name.toLowerCase()}@example.com`,phone:"010-1234-5678",arrivalDate:arrival,departureDate:departure,roomTypeId:"rt-dlx",adults:"2",children:"0",ratePlan:"BAR",source:"Integration",nightlyRate:"180000",rateOverride:"false"},`detail-create-${name}`);
      assert.equal(response.status,200,await response.text());
    }
    const [source,target]=await sql`SELECT r.id,r.confirmation_no,r.guest_id,r.version,g.first_name FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id WHERE r.property_id='prop-seoul' AND g.first_name IN (${firstName},${secondName}) ORDER BY g.first_name DESC`;
    assert.equal(source.first_name,firstName);
    const update=await post({action:"update_reservation_detail",reservationId:source.id,expectedVersion:String(source.version),bookerName:"Agency Booker",bookerPhone:"02-123-4567",bookerEmail:"booker@example.com",guestFirstName:"Actual",guestLastName:"Staying Guest",guestPhone:"010-9999-1111",guestEmail:"stay@example.com",adults:"1",children:"1",channelProductName:"Breakfast Package",paymentType:"PREPAID",guestRequest:"High floor",guestRequestResponse:"Assigned where possible",managerMemo:"VIP review",hotelMemo:"Welcome amenity",reservationChecked:"true",earlyCheckin:"true",earlyCheckinTime:"08:30",lateCheckout:"true",lateCheckoutTime:"14:00",cardInfoRef:"tok_test_****4242",serviceFeeIncluded:"false"},`detail-update-${suffix}`);
    assert.equal(update.status,200,await update.text());
    const link=await post({action:"link_reservation",reservationId:source.id,linkedConfirmationNo:target.confirmation_no,relationType:"COMPANION",notes:"Travel together"},`detail-link-${suffix}`);
    assert.equal(link.status,200,await link.text());
    const scoped=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul");
    const detail=await loadReservationDetail(scoped,source.id,{piiMode:"FULL"});
    assert.equal(detail.reservation.booker_name,"Agency Booker");
    assert.equal(detail.reservation.first_name,"Actual");
    assert.equal(detail.reservation.children,1);
    assert.equal(detail.reservation.early_checkin_time,"08:30:00");
    assert.ok(Array.isArray(detail.reservation.cancellation_terms));
    assert.equal(detail.links[0].confirmation_no,target.confirmation_no);
    assert.ok(detail.logs.edits.some(row=>row.action==="UPDATE_RESERVATION_DETAIL"));
    const concurrentPayload={action:"update_reservation_detail",reservationId:source.id,expectedVersion:"2",bookerName:"Agency Booker",bookerPhone:"02-123-4567",bookerEmail:"booker@example.com",guestFirstName:"Actual",guestLastName:"Staying Guest",guestPhone:"010-9999-1111",guestEmail:"stay@example.com",adults:"1",children:"1",channelProductName:"Breakfast Package",paymentType:"PREPAID",guestRequest:"Concurrent edit",guestRequestResponse:"Assigned",managerMemo:"Reviewed",hotelMemo:"Amenity",reservationChecked:"true",earlyCheckin:"false",lateCheckout:"false",cardInfoRef:"tok_test_****4242",serviceFeeIncluded:"false"};
    const concurrent=await Promise.all([post(concurrentPayload,`detail-race-a-${suffix}`),post({...concurrentPayload,guestRequest:"Competing edit"},`detail-race-b-${suffix}`)]);
    assert.deepEqual(concurrent.map(response=>response.status).sort((a,b)=>a-b),[200,409]);
    const rejected=await post({action:"update_reservation_detail",reservationId:source.id,expectedVersion:"3",bookerName:"Agency Booker",guestFirstName:"Actual",guestLastName:"Staying Guest",adults:"1",children:"1",paymentType:"PREPAID",reservationChecked:"true",earlyCheckin:"false",lateCheckout:"false",cardInfoRef:"4111111111111111"},`detail-pci-${suffix}`);
    assert.equal(rejected.status,400);
    const [unchanged]=await sql`SELECT version,card_info_ref FROM reservations WHERE id=${source.id}`;
    assert.equal(unchanged.version,3);assert.equal(unchanged.card_info_ref,"tok_test_****4242");
    const [contract]=await sql`SELECT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.reservation_links'::regclass) forced_rls,(SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='early_checkin_time') early_type`;
    assert.equal(contract.forced_rls,true);assert.equal(contract.early_type,"time without time zone");
  } finally {
    await sql.begin(async(tx)=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");const rows=await tx`SELECT r.id,r.guest_id FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id WHERE r.property_id='prop-seoul' AND g.first_name IN (${firstName},${secondName},'Actual')`;for(const row of rows){await tx`DELETE FROM reservation_links WHERE property_id='prop-seoul' AND (reservation_id=${row.id} OR linked_reservation_id=${row.id})`;await tx`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id}))`;await tx`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id})`;await tx`DELETE FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${row.id}`;await tx`DELETE FROM reservation_rate_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;await tx`DELETE FROM reservation_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;await tx`DELETE FROM reservation_type_nights WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;await tx`DELETE FROM folio_windows WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;await tx`DELETE FROM reservation_mutations WHERE property_id='prop-seoul' AND reservation_id=${row.id}`;await tx`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND entity_id=${row.id}`;await tx`DELETE FROM reservations WHERE id=${row.id}`;await tx`DELETE FROM guests WHERE id=${row.guest_id}`;}});
    for(const key of keys)await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${key}`;
    await sql`DELETE FROM api_rate_limits WHERE scope='pms-write'`;await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;await closePmsDatabase();
    for(const [key,value] of Object.entries(previous)){const envKey={databaseUrl:"DATABASE_URL",allow:"PMS_ALLOW_DEMO_AUTH",token:"PMS_DEMO_AUTH_TOKEN",email:"PMS_DEMO_USER_EMAIL",rate:"PMS_RATE_LIMIT_SECRET",node:"NODE_ENV"}[key];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
    await sql.end({timeout:2});
  }
});

test("voucher queue snapshots KR/EN visibility and deduplicates concurrent email requests",{skip},async()=>{
  const sql=client(2),suffix=crypto.randomUUID().slice(0,8),email=`voucher-${suffix}@example.com`,assignmentId=`it-voucher-role-${suffix}`,token=`voucher-token-${crypto.randomUUID()}`,key=`voucher-queue-${suffix}`;
  const previous={databaseUrl:process.env.DATABASE_URL,allow:process.env.PMS_ALLOW_DEMO_AUTH,token:process.env.PMS_DEMO_AUTH_TOKEN,email:process.env.PMS_DEMO_USER_EMAIL,rate:process.env.PMS_RATE_LIMIT_SECRET,node:process.env.NODE_ENV};
  const permissions={overview:"WRITE",frontdesk:"WRITE",inventory:"WRITE",website:"WRITE",groups:"WRITE",finance:"WRITE",accounting:"WRITE",channels:"WRITE",rooms:"WRITE",reports:"WRITE",master:"WRITE",revenue:"WRITE",users:"WRITE",audit:"WRITE"};
  let deliveryIds=[];
  try{
    const [reservation]=await sql`SELECT id,confirmation_no FROM reservations WHERE property_id='prop-seoul' ORDER BY created_at LIMIT 1`;assert.ok(reservation);
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},'prop-seoul',${email},'PROPERTY_ADMIN',true,now(),'Voucher Command',${sql.json(permissions)},true,now())`;
    process.env.DATABASE_URL=databaseUrl;process.env.PMS_ALLOW_DEMO_AUTH="true";process.env.PMS_DEMO_AUTH_TOKEN=token;process.env.PMS_DEMO_USER_EMAIL=email;process.env.PMS_RATE_LIMIT_SECRET=`voucher-rate-${crypto.randomUUID()}`;process.env.NODE_ENV="test";
    const body={action:"queue_reservation_voucher",reservationId:reservation.id,language:"EN",showAmount:"false",recipientEmail:"guest@example.com",subject:`Booking ${reservation.confirmation_no}`},post=()=>handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":key},body:JSON.stringify(body)}));
    const responses=await Promise.all([post(),post()]);assert.deepEqual(responses.map(response=>response.status),[200,200]);assert.equal(responses.filter(response=>response.headers.get("X-Idempotent-Replay")==="true").length,1);
    const deliveries=await sql`SELECT id,language,show_amount,recipient_email,subject,document_payload,status FROM reservation_voucher_deliveries WHERE property_id='prop-seoul' AND idempotency_key=${key}`;deliveryIds=deliveries.map(row=>row.id);assert.equal(deliveries.length,1);assert.equal(deliveries[0].language,"EN");assert.equal(deliveries[0].show_amount,false);assert.equal(deliveries[0].status,"QUEUED");assert.equal(deliveries[0].document_payload.amountVisible,false);assert.equal("cardInfoRef" in deliveries[0].document_payload.reservation,false);
    const jobs=await sql`SELECT id,job_type,status FROM worker_jobs WHERE property_id='prop-seoul' AND source_id=${deliveries[0].id}`;assert.equal(jobs.length,1);assert.equal(jobs[0].job_type,"VOUCHER_EMAIL");assert.equal(jobs[0].status,"PENDING");
    const scoped=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-busan"),hidden=await scoped.prepare("SELECT COUNT(*) count FROM reservation_voucher_deliveries WHERE id=? AND property_id=pms_current_property_id()").bind(deliveries[0].id).first();assert.equal(Number(hidden?.count||0),0);
    const [contract]=await sql`SELECT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.reservation_voucher_deliveries'::regclass) forced_rls,(SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='reservation_voucher_deliveries' AND column_name='show_amount') amount_type,(SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='reservation_voucher_deliveries' AND column_name='document_payload') payload_type`;assert.equal(contract.forced_rls,true);assert.equal(contract.amount_type,"boolean");assert.equal(contract.payload_type,"jsonb");
    await assert.rejects(()=>sql`UPDATE reservation_voucher_deliveries SET subject='tampered' WHERE id=${deliveries[0].id}`,/voucher delivery snapshot is immutable/iu);
    await sql`UPDATE reservation_voucher_deliveries SET status='SENDING',attempts=attempts+1 WHERE id=${deliveries[0].id}`;
  }finally{
    if(!deliveryIds.length){const residue=await sql`SELECT id FROM reservation_voucher_deliveries WHERE property_id='prop-seoul' AND idempotency_key=${key}`;deliveryIds=residue.map(row=>row.id);}
    if(deliveryIds.length){await sql`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id=ANY(${deliveryIds}))`;await sql`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id=ANY(${deliveryIds})`;await sql`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND entity_id=ANY(${deliveryIds})`;await sql`DELETE FROM reservation_voucher_deliveries WHERE property_id='prop-seoul' AND id=ANY(${deliveryIds})`;}
    await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${key}`;await sql`DELETE FROM api_rate_limits WHERE scope='pms-write'`;await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;await closePmsDatabase();for(const [entry,value] of Object.entries(previous)){const envKey={databaseUrl:"DATABASE_URL",allow:"PMS_ALLOW_DEMO_AUTH",token:"PMS_DEMO_AUTH_TOKEN",email:"PMS_DEMO_USER_EMAIL",rate:"PMS_RATE_LIMIT_SECRET",node:"NODE_ENV"}[entry];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}await sql.end({timeout:2});
  }
});

test("HotelStory channel settings and rate blocks are transactional, bounded, and tenant isolated",{skip},async()=>{
  const sql=client(3),suffix=crypto.randomUUID().slice(0,8),email=`rate-block-${suffix}@example.com`,assignmentId=`it-rate-block-role-${suffix}`,token=`rate-block-token-${crypto.randomUUID()}`;
  const providerCode=`IT_${suffix.toUpperCase()}`,catalogId=`it-catalog-${suffix}`,mappingId=`it-mapping-${suffix}`,contractId=`it-contract-${suffix}`;
  const from="2032-04-01",to="2032-04-02",keys=[];
  const previous={databaseUrl:process.env.DATABASE_URL,allow:process.env.PMS_ALLOW_DEMO_AUTH,token:process.env.PMS_DEMO_AUTH_TOKEN,email:process.env.PMS_DEMO_USER_EMAIL,rate:process.env.PMS_RATE_LIMIT_SECRET,node:process.env.NODE_ENV};
  const permissions={overview:"WRITE",frontdesk:"WRITE",inventory:"WRITE",website:"WRITE",groups:"WRITE",finance:"WRITE",accounting:"WRITE",channels:"WRITE",rooms:"WRITE",reports:"WRITE",master:"WRITE",revenue:"WRITE",users:"WRITE",audit:"WRITE"};
  let settingId="",connectionId="",cutoffId="",planId="",seasonId="",holidayId="",amenityId="",serviceId="",ariIds=[],outboxIds=[];
  const post=async(body,label)=>{const key=`rate-block-${label}-${suffix}`;keys.push(key);const response=await handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":key},body:JSON.stringify(body)}));return {response,key};};
  const expectOk=async(body,label)=>{const {response,key}=await post(body,label);assert.equal(response.status,200,`${body.action}: ${await response.text()}`);return {response,key};};
  try{
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},'prop-seoul',${email},'PROPERTY_ADMIN',true,now(),'Rate Block Command',${sql.json(permissions)},true,now())`;
    process.env.DATABASE_URL=databaseUrl;process.env.PMS_ALLOW_DEMO_AUTH="true";process.env.PMS_DEMO_AUTH_TOKEN=token;process.env.PMS_DEMO_USER_EMAIL=email;process.env.PMS_RATE_LIMIT_SECRET=`rate-block-limit-${crypto.randomUUID()}`;process.env.NODE_ENV="test";

    await expectOk({action:"upsert_channel_catalog",catalogId,providerCode,displayName:"Integration OTA",channelClass:"OTA",integrationMode:"INTEGRATED",description:"PostgreSQL behavior contract",sortOrder:"1"},"catalog");
    await expectOk({action:"configure_property_channel",catalogId,active:"true",sortOrder:"1",supplierName:"Integration Supplier",supplierCode:"IT-SUPPLIER",supplierConfig:'{"mode":"test"}',externalPropertyId:`hotel-${suffix}`,separateManagement:"false",salesCutoffDays:"0"},"configure");
    [{id:settingId,connection_id:connectionId}]=await sql`SELECT id,connection_id FROM property_channel_settings WHERE property_id='prop-seoul' AND catalog_id=${catalogId}`;
    assert.ok(settingId&&connectionId);
    [{id:planId}]=await sql`SELECT id FROM rate_plans WHERE property_id='prop-seoul' AND code='BAR'`;
    await sql`INSERT INTO channel_mappings(id,property_id,connection_id,room_type_id,external_room_type_id,rate_plan,external_rate_plan_id,active,created_at,updated_at) VALUES (${mappingId},'prop-seoul',${connectionId},'rt-dlx',${`room-${suffix}`},'BAR',${`bar-${suffix}`},true,now(),now())`;
    await sql`INSERT INTO channel_contracts(id,property_id,connection_id,contract_type,commission_percent,settlement_cycle,payment_terms_days,currency,valid_from,valid_to,status,version,created_at,created_by,updated_at,updated_by) VALUES (${contractId},'prop-seoul',${connectionId},'COMMISSION',15,'PER_STAY',30,'KRW','2031-01-01',NULL,'ACTIVE',1,now(),'integration-test',now(),'integration-test')`;

    await expectOk({action:"upsert_channel_product_cutoff",settingId,ratePlanId:planId,cutoffDays:"0",cutoffTime:"23:59",active:"true"},"cutoff");
    [{id:cutoffId}]=await sql`SELECT id FROM channel_product_cutoffs WHERE property_id='prop-seoul' AND setting_id=${settingId} AND rate_plan_id=${planId}`;
    const bulkBody={action:"bulk_update_rate_blocks",mappingIds:JSON.stringify([mappingId]),from,to,weekdays:JSON.stringify([0,1,2,3,4,5,6]),allocation:"2",sellRate:"245000",netRate:"",closed:"false",minStay:"2",cta:"true",ctd:"false"};
    const {key:bulkKey}=await expectOk(bulkBody,"bulk");
    const replay=await handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":bulkKey},body:JSON.stringify(bulkBody)}));
    assert.equal(replay.status,200);assert.equal(replay.headers.get("X-Idempotent-Replay"),"true");
    const overrides=await sql`SELECT stay_date,allocation,sell_rate,net_rate,closed,min_stay,close_to_arrival,close_to_departure FROM channel_rate_overrides WHERE property_id='prop-seoul' AND mapping_id=${mappingId} ORDER BY stay_date`;
    assert.equal(overrides.length,2);assert.deepEqual(overrides.map(row=>Number(row.allocation)),[2,2]);assert.deepEqual(overrides.map(row=>Number(row.sell_rate)),[245000,245000]);assert.ok(overrides.every(row=>row.net_rate===null&&!row.closed&&row.min_stay===2&&row.close_to_arrival&&!row.close_to_departure));
    const ari=await sql`SELECT id,stay_date,available,revision,payload_json FROM ari_updates WHERE property_id='prop-seoul' AND mapping_id=${mappingId} ORDER BY stay_date`;ariIds=ari.map(row=>row.id);
    assert.equal(ari.length,2);assert.ok(ari.every(row=>row.available===2&&row.revision===1&&row.payload_json.rate===245000));
    const outbox=await sql`SELECT id,aggregate_id,topic FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=ANY(${ariIds}) ORDER BY aggregate_id`;outboxIds=outbox.map(row=>row.id);assert.equal(outbox.length,2);assert.ok(outbox.every(row=>row.topic==="channel.ari_delta"));

    const scoped=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul");
    const matrix=await loadRateBlockMatrix(scoped,new URLSearchParams({from,to,connectionId}));assert.equal(matrix.rows.length,1);assert.equal(matrix.rows[0].cells.length,2);assert.equal(matrix.rows[0].cells[0].allocation,2);assert.equal(matrix.rows[0].cells[0].poolAvailable,3);
    const hidden=await loadRateBlockMatrix(scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-busan"),new URLSearchParams({from,to,connectionId}));assert.equal(hidden.rows.length,0);

    const over=await post({...bulkBody,allocation:"4"},"over-allocation");assert.equal(over.response.status,409,await over.response.text());
    assert.equal((await sql`SELECT COUNT(*)::int count FROM channel_rate_overrides WHERE property_id='prop-seoul' AND mapping_id=${mappingId}`)[0].count,2);
    const [{version}]=await sql`SELECT version FROM property_channel_settings WHERE id=${settingId}`;
    await expectOk({action:"set_property_channel_active",settingId,active:"false",expectedVersion:String(version)},"disable");
    assert.equal((await loadRateBlockMatrix(scoped,new URLSearchParams({from,to,connectionId}))).rows.length,0);
    const disabledQueue=await post({action:"queue_ari_delta",mappingId,startDate:from,endDate:to},"disabled-ari");assert.equal(disabledQueue.response.status,400,await disabledQueue.response.text());
    const [{version:disabledVersion}]=await sql`SELECT version FROM property_channel_settings WHERE id=${settingId}`;
    await expectOk({action:"set_property_channel_active",settingId,active:"true",expectedVersion:String(disabledVersion)},"enable");
    assert.equal((await loadChannelCatalog(scoped)).catalog.find(row=>row.id===catalogId)?.connection_status,"ACTIVE");
    const activeAriBody={action:"queue_ari_delta",mappingId,startDate:"2032-04-03",endDate:"2032-04-03"},{key:activeAriKey}=await expectOk(activeAriBody,"active-ari");
    const activeAriReplay=await handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":activeAriKey},body:JSON.stringify(activeAriBody)}));assert.equal(activeAriReplay.status,200);assert.equal(activeAriReplay.headers.get("X-Idempotent-Replay"),"true");
    const allAri=await sql`SELECT id FROM ari_updates WHERE property_id='prop-seoul' AND mapping_id=${mappingId}`;ariIds=allAri.map(row=>row.id);assert.equal(ariIds.length,3);
    const allOutbox=await sql`SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=ANY(${ariIds})`;outboxIds=allOutbox.map(row=>row.id);assert.equal(outboxIds.length,3);

    await expectOk({action:"upsert_property_season",name:`Integration Peak ${suffix}`,seasonType:"PEAK",startDate:from,endDate:to,adjustmentType:"PERCENT",adjustment:"12.5",active:"true"},"season");
    await expectOk({action:"upsert_property_holiday",name:`Integration Day ${suffix}`,stayDate:from,holidayType:"HOTEL",active:"true"},"holiday");
    await expectOk({action:"upsert_amenity_catalog",code:`AM_${suffix.toUpperCase()}`,name:"Integration Amenity",category:"ROOM",iconName:"sparkles",sortOrder:"1",active:"true"},"amenity");
    await expectOk({action:"upsert_service_catalog",code:`SV_${suffix.toUpperCase()}`,name:"Integration Service",category:"ROOM",pricingType:"FIXED",price:"33000",currency:"KRW",description:"Behavior contract",sortOrder:"1",active:"true"},"service");
    [{id:seasonId}]=await sql`SELECT id FROM property_seasons WHERE property_id='prop-seoul' AND name=${`Integration Peak ${suffix}`}`;[{id:holidayId}]=await sql`SELECT id FROM property_holidays WHERE property_id='prop-seoul' AND name=${`Integration Day ${suffix}`}`;[{id:amenityId}]=await sql`SELECT id FROM amenity_catalog WHERE property_id='prop-seoul' AND code=${`AM_${suffix.toUpperCase()}`}`;[{id:serviceId}]=await sql`SELECT id FROM service_catalog WHERE property_id='prop-seoul' AND code=${`SV_${suffix.toUpperCase()}`}`;
    const catalogs=await loadOperationalCatalogs(scoped);assert.ok(catalogs.seasons.some(row=>row.id===seasonId));assert.ok(catalogs.holidays.some(row=>row.id===holidayId));assert.ok(catalogs.amenities.some(row=>row.id===amenityId));assert.ok(catalogs.services.some(row=>row.id===serviceId));
    const tenantCatalogs=await loadOperationalCatalogs(scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-busan"));assert.ok(!tenantCatalogs.seasons.some(row=>row.id===seasonId));
    const [contract]=await sql`SELECT COUNT(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity)::int forced FROM pg_class WHERE oid IN ('public.channel_catalog'::regclass,'public.property_channel_settings'::regclass,'public.channel_product_cutoffs'::regclass,'public.property_seasons'::regclass,'public.property_holidays'::regclass,'public.amenity_catalog'::regclass,'public.service_catalog'::regclass)`;assert.equal(contract.forced,7);
  }finally{
    await closePmsDatabase();
    if(outboxIds.length){await sql`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id=ANY(${outboxIds}))`;await sql`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id=ANY(${outboxIds})`;}
    if(ariIds.length){await sql`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id=ANY(${ariIds}))`;await sql`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id=ANY(${ariIds})`;}
    if(outboxIds.length)await sql`DELETE FROM outbox_events WHERE property_id='prop-seoul' AND id=ANY(${outboxIds})`;
    if(ariIds.length)await sql`DELETE FROM ari_updates WHERE property_id='prop-seoul' AND id=ANY(${ariIds})`;
    await sql`DELETE FROM channel_rate_overrides WHERE property_id='prop-seoul' AND mapping_id=${mappingId}`;
    if(cutoffId)await sql`DELETE FROM channel_product_cutoffs WHERE id=${cutoffId}`;
    if(mappingId)await sql`DELETE FROM channel_mappings WHERE id=${mappingId}`;
    if(contractId)await sql`DELETE FROM channel_contracts WHERE id=${contractId}`;
    if(settingId)await sql`DELETE FROM property_channel_settings WHERE id=${settingId}`;
    if(connectionId)await sql`DELETE FROM channel_connections WHERE id=${connectionId}`;
    if(catalogId)await sql`DELETE FROM channel_catalog WHERE id=${catalogId}`;
    for(const [table,id] of [["property_seasons",seasonId],["property_holidays",holidayId],["amenity_catalog",amenityId],["service_catalog",serviceId]])if(id)await sql.unsafe(`DELETE FROM ${table} WHERE id=$1`,[id]);
    await sql`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND actor=${email}`;
    for(const key of keys)await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${key}`;
    await sql`DELETE FROM api_rate_limits WHERE scope='pms-write'`;await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;
    for(const [entry,value] of Object.entries(previous)){const envKey={databaseUrl:"DATABASE_URL",allow:"PMS_ALLOW_DEMO_AUTH",token:"PMS_DEMO_AUTH_TOKEN",email:"PMS_DEMO_USER_EMAIL",rate:"PMS_RATE_LIMIT_SECRET",node:"NODE_ENV"}[entry];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}
    await sql.end({timeout:2});
  }
});

test("HotelStory reports reconcile lead time, booking curve, YoY, and reversible channel deposits",{skip},async()=>{
  const sql=client(4),suffix=crypto.randomUUID().slice(0,8),email=`report-${suffix}@example.com`,assignmentId=`it-report-role-${suffix}`,token=`report-token-${crypto.randomUUID()}`;
  const guestCurrent=`it-report-guest-current-${suffix}`,guestPrior=`it-report-guest-prior-${suffix}`,guestLate=`it-report-guest-late-${suffix}`,reservationCurrent=`it-report-res-current-${suffix}`,reservationPrior=`it-report-res-prior-${suffix}`,reservationLate=`it-report-res-late-${suffix}`,connectionId=`it-report-channel-${suffix}`,contractId=`it-report-contract-${suffix}`;
  const confirmationCurrent=`RC-${suffix.toUpperCase()}`,confirmationPrior=`RP-${suffix.toUpperCase()}`,confirmationLate=`RL-${suffix.toUpperCase()}`,provider=`RPT_${suffix.toUpperCase()}`,keys=[];
  const previous={databaseUrl:process.env.DATABASE_URL,allow:process.env.PMS_ALLOW_DEMO_AUTH,token:process.env.PMS_DEMO_AUTH_TOKEN,email:process.env.PMS_DEMO_USER_EMAIL,rate:process.env.PMS_RATE_LIMIT_SECRET,node:process.env.NODE_ENV};
  const permissions={overview:"WRITE",frontdesk:"WRITE",inventory:"WRITE",website:"WRITE",groups:"WRITE",finance:"WRITE",accounting:"WRITE",channels:"WRITE",rooms:"WRITE",reports:"WRITE",master:"WRITE",revenue:"WRITE",users:"WRITE",audit:"WRITE"};
  let settlementId="";
  const isoDate=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
  const post=async(body,label,key=`report-${label}-${suffix}`)=>{keys.push(key);return handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":key},body:JSON.stringify(body)}));};
  try{
    const [{business_date:rawBusinessDate}]=await sql`SELECT business_date FROM properties WHERE id='prop-seoul'`,businessDate=isoDate(rawBusinessDate);
    await sql`INSERT INTO role_assignments(id,property_id,email,role,active,created_at,display_name,workspace_permissions,can_export,updated_at) VALUES (${assignmentId},'prop-seoul',${email},'PROPERTY_ADMIN',true,now(),'Report Command',${sql.json(permissions)},true,now())`;
    await sql`INSERT INTO guests(id,property_id,first_name,last_name,email,created_at) VALUES (${guestCurrent},'prop-seoul','Curve','Current','curve-current@example.com','2031-01-04T18:30:00Z'),(${guestPrior},'prop-seoul','Curve','Prior','curve-prior@example.com','2030-01-04T18:30:00Z'),(${guestLate},'prop-seoul','Late','Import','late-import@example.com','2031-02-02T10:00:00Z')`;
    await sql`INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,created_at,updated_at,payment_type) VALUES (${reservationCurrent},${confirmationCurrent},'prop-seoul',${guestCurrent},'rt-dlx','2031-02-01','2031-02-03','DUE_IN',2,0,${provider},'BAR',100000,'2031-01-04T18:30:00Z','2031-01-04T18:30:00Z','CHANNEL'),(${reservationPrior},${confirmationPrior},'prop-seoul',${guestPrior},'rt-dlx','2030-02-01','2030-02-03','CHECKED_OUT',2,0,${provider},'BAR',80000,'2030-01-04T18:30:00Z','2030-01-04T18:30:00Z','CHANNEL'),(${reservationLate},${confirmationLate},'prop-seoul',${guestLate},'rt-dlx','2031-02-01','2031-02-03','DUE_IN',1,0,'LATE_IMPORT','BAR',90000,'2031-02-02T10:00:00Z','2031-02-02T10:00:00Z','HOTEL')`;
    await sql`INSERT INTO channel_connections(id,property_id,provider,external_property_id,name,environment,status,created_at,updated_at,created_by) VALUES (${connectionId},'prop-seoul',${provider},${`hotel-${suffix}`},'Report OTA','SANDBOX','ACTIVE',now(),now(),'integration-test')`;
    await sql`INSERT INTO channel_contracts(id,property_id,connection_id,contract_type,commission_percent,settlement_cycle,payment_terms_days,currency,valid_from,valid_to,status,version,created_at,created_by,updated_at,updated_by) VALUES (${contractId},'prop-seoul',${connectionId},'COMMISSION',10,'PER_STAY',30,'KRW','2029-01-01',NULL,'ACTIVE',1,now(),'integration-test',now(),'integration-test')`;
    process.env.DATABASE_URL=databaseUrl;process.env.PMS_ALLOW_DEMO_AUTH="true";process.env.PMS_DEMO_AUTH_TOKEN=token;process.env.PMS_DEMO_USER_EMAIL=email;process.env.PMS_RATE_LIMIT_SECRET=`report-limit-${crypto.randomUUID()}`;process.env.NODE_ENV="test";
    const scoped=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul"),principal={email,role:"PROPERTY_ADMIN",capabilities:["REPORT_EXPORT","ACCOUNTING_WRITE"]};
    const detail=await runReport(scoped,new URLSearchParams({report:"reservations",from:"2031-02-01",to:"2031-02-28",q:confirmationCurrent}),principal);assert.equal(detail.rows.length,1);assert.equal(Number(detail.rows[0].lead_time_days),27);assert.equal(detail.rows[0].booking_time_band,"00–06");
    const lateImport=await runReport(scoped,new URLSearchParams({report:"reservations",from:"2031-02-01",to:"2031-02-28",q:confirmationLate}),principal);assert.equal(lateImport.rows.length,1);assert.equal(Number(lateImport.rows[0].lead_time_days),0);assert.equal(Number(lateImport.summary.find(item=>item.label==="평균 리드타임")?.value),0);
    const lateCurve=await runReport(scoped,new URLSearchParams({report:"booking_curve",from:"2031-02-02",to:"2031-02-02",source:"LATE_IMPORT"}),principal);assert.equal(Number(lateCurve.rows[0].avg_lead_time),0);
    const curve=await runReport(scoped,new URLSearchParams({report:"booking_curve",from:"2031-01-05",to:"2031-01-05",source:provider}),principal);assert.equal(curve.rows.length,1);assert.equal(Number(curve.rows[0].booked_00_06),1);assert.equal(Number(curve.rows[0].booked_06_12),0);assert.equal(Number(curve.rows[0].booked_revenue),200000);assert.equal(Number(curve.rows[0].avg_lead_time),27);
    const yoy=await runReport(scoped,new URLSearchParams({report:"yoy",from:"2031-02-01",to:"2031-02-28",source:provider}),principal);assert.equal(yoy.rows.length,1);assert.equal(Number(yoy.rows[0].current_book),1);assert.equal(Number(yoy.rows[0].prior_book),1);assert.equal(Number(yoy.rows[0].current_rev),200000);assert.equal(Number(yoy.rows[0].prior_rev),160000);assert.equal(Number(yoy.rows[0].rev_yoy),25);
    const deferred=await runReport(scoped,new URLSearchParams({report:"deferred_settlements",from:businessDate,to:businessDate}),principal);assert.equal(deferred.report.key,"deferred_settlements");assert.ok(Array.isArray(deferred.rows));
    const accrual=await post({action:"accrue_channel_settlement",connectionId,reservationId:reservationCurrent},"accrue");assert.equal(accrual.status,200,await accrual.text());
    [{id:settlementId}]=await sql`SELECT id FROM channel_settlements WHERE property_id='prop-seoul' AND connection_id=${connectionId} AND reservation_id=${reservationCurrent}`;assert.ok(settlementId);
    const receiptKey=`report-receipt-${suffix}`,receiptBody={action:"mark_channel_settlement_paid",settlementId,depositDate:String(businessDate),memo:"HotelStory deposit reconciliation"},receipt=await post(receiptBody,"receipt",receiptKey);assert.equal(receipt.status,200,await receipt.text());
    const replay=await handlePmsPost(new Request("http://localhost/api/pms",{method:"POST",headers:{"content-type":"application/json","x-aurora-demo-token":token,"idempotency-key":receiptKey},body:JSON.stringify(receiptBody)}));assert.equal(replay.status,200);assert.equal(replay.headers.get("X-Idempotent-Replay"),"true");
    const [paid]=await sql`SELECT status,deposit_date,deposit_memo,payment_journal_id FROM channel_settlements WHERE id=${settlementId}`;assert.equal(paid.status,"PAID");assert.equal(isoDate(paid.deposit_date),businessDate);assert.equal(paid.deposit_memo,"HotelStory deposit reconciliation");assert.ok(paid.payment_journal_id);
    const receipts=await sql`SELECT * FROM channel_deposit_events WHERE property_id='prop-seoul' AND settlement_id=${settlementId} AND event_type='RECEIPT'`;assert.equal(receipts.length,1);assert.equal(Number(receipts[0].amount),180000);
    const deposits=await runReport(scoped,new URLSearchParams({report:"channel_deposits",from:businessDate,to:isoDate((await sql`SELECT due_date FROM channel_settlements WHERE id=${settlementId}`)[0].due_date),status:"PAID",scope:"EXCLUDE_ONSITE",q:confirmationCurrent}),principal);assert.equal(deposits.rows.length,1);assert.equal(deposits.rows[0].deposit_memo,"HotelStory deposit reconciliation");assert.equal(Number(deposits.rows[0].hotel_net_amount),180000);
    const restore=await post({action:"restore_channel_settlement_payment",settlementId,restoreDate:String(businessDate),reason:"Bank deposit mismatch"},"restore");assert.equal(restore.status,200,await restore.text());
    const [restored]=await sql`SELECT status,paid_at,deposit_date,payment_journal_id FROM channel_settlements WHERE id=${settlementId}`;assert.equal(restored.status,"ACCRUED");assert.equal(restored.paid_at,null);assert.equal(restored.deposit_date,null);assert.equal(restored.payment_journal_id,null);
    const events=await sql`SELECT event_type,reverses_event_id,accounting_journal_id FROM channel_deposit_events WHERE property_id='prop-seoul' AND settlement_id=${settlementId} ORDER BY created_at`;assert.deepEqual(events.map(row=>row.event_type),["RECEIPT","RESTORE"]);assert.equal(events[1].reverses_event_id,receipts[0].id);
    const [originalJournal]=await sql`SELECT status FROM accounting_journal_entries WHERE id=${paid.payment_journal_id}`;assert.equal(originalJournal.status,"REVERSED");
    await assert.rejects(sql`UPDATE channel_deposit_events SET memo='tampered' WHERE id=${receipts[0].id}`,/immutable/iu);
    const concurrentBody={action:"mark_channel_settlement_paid",settlementId,depositDate:businessDate,memo:"Concurrent deposit"},concurrent=await Promise.all([post(concurrentBody,"concurrent-a"),post(concurrentBody,"concurrent-b")]);assert.deepEqual(concurrent.map(response=>response.status).sort((a,b)=>a-b),[200,409]);
    const receiptCount=await sql`SELECT COUNT(*)::int count FROM channel_deposit_events WHERE property_id='prop-seoul' AND settlement_id=${settlementId} AND event_type='RECEIPT'`;assert.equal(receiptCount[0].count,2);
    const hidden=await runReport(scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-busan"),new URLSearchParams({report:"channel_deposits",from:businessDate,to:businessDate}),principal);assert.ok(!hidden.rows.some(row=>row.settlement_id===settlementId));
    const [contract]=await sql`SELECT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.channel_deposit_events'::regclass) forced_rls,(SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_deposit_events' AND column_name='event_date') event_date_type`;assert.equal(contract.forced_rls,true);assert.equal(contract.event_date_type,"date");
  }finally{
    await closePmsDatabase();
    await sql.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");if(settlementId){await tx`DELETE FROM channel_deposit_events WHERE property_id='prop-seoul' AND settlement_id=${settlementId}`;await tx`DELETE FROM accounting_journal_lines WHERE property_id='prop-seoul' AND journal_entry_id IN (SELECT id FROM accounting_journal_entries WHERE property_id='prop-seoul' AND (source_id=${settlementId} OR source_id LIKE ${`${settlementId}:%`}))`;await tx`DELETE FROM accounting_journal_entries WHERE property_id='prop-seoul' AND (source_id=${settlementId} OR source_id LIKE ${`${settlementId}:%`})`;await tx`DELETE FROM channel_settlements WHERE id=${settlementId}`;}await tx`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND actor=${email}`;await tx`DELETE FROM reservations WHERE id IN (${reservationCurrent},${reservationPrior},${reservationLate})`;await tx`DELETE FROM guests WHERE id IN (${guestCurrent},${guestPrior},${guestLate})`;});
    await sql`DELETE FROM channel_contracts WHERE id=${contractId}`;await sql`DELETE FROM channel_connections WHERE id=${connectionId}`;for(const key of new Set(keys))await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${key}`;await sql`DELETE FROM api_rate_limits WHERE scope='pms-write'`;await sql`DELETE FROM role_assignments WHERE id=${assignmentId}`;
    for(const [entry,value] of Object.entries(previous)){const envKey={databaseUrl:"DATABASE_URL",allow:"PMS_ALLOW_DEMO_AUTH",token:"PMS_DEMO_AUTH_TOKEN",email:"PMS_DEMO_USER_EMAIL",rate:"PMS_RATE_LIMIT_SECRET",node:"NODE_ENV"}[entry];if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;}await sql.end({timeout:2});
  }
});

test("RLS tenant context hides and rejects cross-property access", { skip }, async () => {
  const sql = client(2);
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = `it-a-${suffix}`;
  const second = `it-b-${suffix}`;
  const organizationId=`org-rls-${suffix}`;
  try {
    await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'RLS Organization',${`rls-${suffix}`},'ACTIVE')`;
    await sql`
      INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug)
      VALUES
        (${first},'Tenant A',${`A-${suffix}`},'Asia/Seoul','KRW','2026-08-01',${organizationId},${`tenant-a-${suffix}`}),
        (${second},'Tenant B',${`B-${suffix}`},'Asia/Seoul','KRW','2026-08-01',${organizationId},${`tenant-b-${suffix}`})
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
    await sql`DELETE FROM organizations WHERE id=${organizationId}`;
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
  const organizationId=`org-cap-${suffix}`;
  const roomTypeId = `it-rt-${suffix}`;
  const stayDate = "2031-08-01";
  const reservations = Array.from({ length: 20 }, (_, index) => ({
    id: `it-res-${suffix}-${index}`,
    guestId: `it-guest-${suffix}-${index}`,
    confirmation: `IT-${suffix}-${index}`,
  }));
  try {
    await sql`INSERT INTO organizations(id,name,slug,status) VALUES (${organizationId},'Concurrency Organization',${`cap-${suffix}`},'ACTIVE')`;
    await sql`
      INSERT INTO properties(id,name,code,timezone,currency,business_date,organization_id,slug)
      VALUES (${propertyId},'Concurrency Hotel',${`C-${suffix}`},'Asia/Seoul','KRW','2031-07-31',${organizationId},${`concurrency-${suffix}`})
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
    await sql`DELETE FROM organizations WHERE id=${organizationId}`;
    await sql.end({ timeout: 2 });
  }
});
