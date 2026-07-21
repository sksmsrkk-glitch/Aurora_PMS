/** Integration tests executed against the exact migrated PostgreSQL schema. */
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { consumeRateLimit } from "../app/api/rate-limit.ts";
import { loadPmsSearch, loadReservationAvailability, loadReservationCalendar } from "../app/api/pms/frontdesk-read.ts";
import { snapshot } from "../app/api/pms/read-model.ts";
import { handlePmsPost } from "../app/api/pms/command-gateway.ts";
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
