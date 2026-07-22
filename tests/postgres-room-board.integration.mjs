/** PostgreSQL behavior contracts for physical room/night assignment. */
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { loadReservationAvailability, loadRoomBoard } from "../app/api/pms/frontdesk-read.ts";
import { mapPmsError } from "../app/api/pms/error-map.ts";
import { handleRoomAssignmentAction, RoomAssignmentError } from "../app/api/pms/room-assignment-service.ts";
import { closePmsDatabase, getPmsDatabase, scopePmsDatabase } from "../db/pms-database.ts";

const databaseUrl=process.env.TEST_DATABASE_URL||"";
const required=process.env.AURORA_REQUIRE_POSTGRES_TESTS==="true";
if(required&&!databaseUrl)throw new Error("AURORA_REQUIRE_POSTGRES_TESTS requires TEST_DATABASE_URL");
const skip=!databaseUrl;
const client=(max=6)=>postgres(databaseUrl,{max,prepare:false,ssl:false,idle_timeout:2});

test("room board assignment commands preserve type stock and reject every hard block",{skip},async()=>{
  const sql=client(),suffix=crypto.randomUUID().slice(0,8),db=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul");
  const actor=`room-board-${suffix}@example.com`,principal={email:actor,principalType:"STAFF",piiMode:"FULL"};
  const ids={guestA:`it-board-ga-${suffix}`,guestB:`it-board-gb-${suffix}`,guestC:`it-board-gc-${suffix}`,guestD:`it-board-gd-${suffix}`,guestE:`it-board-ge-${suffix}`,resA:`it-board-ra-${suffix}`,resB:`it-board-rb-${suffix}`,resC:`it-board-rc-${suffix}`,resD:`it-board-rd-${suffix}`,resE:`it-board-re-${suffix}`,roomA:`it-board-room-a-${suffix}`,roomB:`it-board-room-b-${suffix}`,roomC:`it-board-room-c-${suffix}`,roomD:`it-board-room-d-${suffix}`};
  const keys=[];
  const run=(body,key)=>{keys.push(key);return handleRoomAssignmentAction(db,body,principal,new Date().toISOString(),key);};
  try{
    const [bar]=await sql`SELECT id FROM rate_plans WHERE property_id='prop-seoul' AND code='BAR'`;assert.ok(bar?.id);
    await sql`INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES
      (${ids.roomA},'prop-seoul','rt-dlx',${`QA${suffix}A`},90,'VACANT','CLEAN','[]'::jsonb,true,1),
      (${ids.roomB},'prop-seoul','rt-dlx',${`QA${suffix}B`},90,'VACANT','DIRTY','[]'::jsonb,true,1),
      (${ids.roomC},'prop-seoul','rt-dlx',${`QA${suffix}C`},90,'VACANT','CLEAN','[]'::jsonb,true,1),
      (${ids.roomD},'prop-seoul','rt-ste',${`QA${suffix}D`},90,'VACANT','OUT_OF_SERVICE','[]'::jsonb,true,1)`;
    for(const [id,first] of [[ids.guestA,"Alpha"],[ids.guestB,"Bravo"],[ids.guestC,"Charlie"],[ids.guestD,"Delta"],[ids.guestE,"Echo"]])
      await sql`INSERT INTO guests(id,property_id,first_name,last_name,email,phone,created_at) VALUES (${id},'prop-seoul',${first},'Board',${`${first.toLowerCase()}-${suffix}@example.com`},'010-1234-5678',now())`;
    const reservations=[[ids.resA,ids.guestA,"A","2033-01-10","2033-01-13","DUE_IN"],[ids.resB,ids.guestB,"B","2033-01-10","2033-01-12","DUE_IN"],[ids.resC,ids.guestC,"C","2033-01-14","2033-01-16","IN_HOUSE"],[ids.resD,ids.guestD,"D","2033-01-20","2033-01-22","DUE_IN"],[ids.resE,ids.guestE,"E","2033-01-20","2033-01-22","DUE_IN"]];
    for(const [id,guest,code,arrival,departure,status] of reservations){
      await sql`INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,arrival_date,departure_date,status,adults,children,source,rate_plan,rate_plan_id,nightly_rate,created_at,updated_at) VALUES (${id},${`IT-BOARD-${suffix}-${code}`},'prop-seoul',${guest},'rt-dlx',${arrival},${departure},${status},2,0,'INTEGRATION','BAR',${bar.id},180000,now(),now())`;
      await sql`INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) SELECT 'prop-seoul',${id},'rt-dlx',day::date FROM generate_series(${arrival}::date,(${departure}::date-interval '1 day')::date,interval '1 day') day`;
    }
    await run({action:"assign_reservation_room",reservationId:ids.resA,roomId:ids.roomA,expectedVersion:"1"},`board-assign-${suffix}`);
    const [assigned]=await sql`SELECT room_id,status,version,(SELECT COUNT(*)::int FROM reservation_nights WHERE reservation_id=${ids.resA}) physical,(SELECT COUNT(*)::int FROM reservation_type_nights WHERE reservation_id=${ids.resA}) typed FROM reservations WHERE id=${ids.resA}`;
    assert.deepEqual({room:assigned.room_id,status:assigned.status,version:assigned.version,physical:assigned.physical,typed:assigned.typed},{room:ids.roomA,status:"DUE_IN",version:2,physical:3,typed:3});

    await assert.rejects(run({action:"assign_reservation_room",reservationId:ids.resB,roomId:ids.roomA,expectedVersion:"1"},`board-collision-${suffix}`),error=>mapPmsError(error.message)?.error==="해당 객실은 그 날짜에 이미 배정되어 있습니다");
    await assert.rejects(run({action:"assign_reservation_room",reservationId:ids.resA,roomId:ids.roomB,expectedVersion:"1"},`board-stale-${suffix}`),error=>error instanceof RoomAssignmentError&&error.status===409);
    await assert.rejects(run({action:"assign_reservation_room",reservationId:ids.resB,roomId:ids.roomD,expectedVersion:"1"},`board-oos-${suffix}`),error=>error instanceof RoomAssignmentError&&error.status===409);

    await assert.rejects(run({action:"move_reservation_room",reservationId:ids.resA,roomId:ids.roomB,moveDate:"2033-01-12",reason:"ROOM_BOARD",expectedVersion:"2"},`board-warning-required-${suffix}`),error=>error instanceof RoomAssignmentError&&error.status===400);
    await run({action:"move_reservation_room",reservationId:ids.resA,roomId:ids.roomB,moveDate:"2033-01-12",reason:"ROOM_BOARD",expectedVersion:"2",warningOverride:"true"},`board-move-${suffix}`);
    const moved=await sql`SELECT stay_date,room_id FROM reservation_nights WHERE reservation_id=${ids.resA} ORDER BY stay_date`;
    assert.deepEqual(moved.map(row=>[row.stay_date instanceof Date?row.stay_date.toISOString().slice(0,10):String(row.stay_date),row.room_id]),[["2033-01-10",ids.roomA],["2033-01-11",ids.roomA],["2033-01-12",ids.roomB]]);
    const [moveCount]=await sql`SELECT COUNT(*)::int count FROM room_moves WHERE reservation_id=${ids.resA}`;assert.equal(moveCount.count,1);
    const [warningAudit]=await sql`SELECT after_json FROM audit_logs WHERE entity_id=${ids.resA} AND action='MOVE_RESERVATION_ROOM' ORDER BY created_at DESC LIMIT 1`;
    assert.equal(warningAudit.after_json.warnings.dirty,true);

    const board=await loadRoomBoard(db,new URLSearchParams({from:"2033-01-10",to:"2033-01-14"}),principal);
    assert.equal(board.spans.filter(span=>span.reservation.id===ids.resA).length,2);
    assert.ok(board.unassigned.some(row=>row.id===ids.resB));
    const masked=await loadRoomBoard(db,new URLSearchParams({from:"2033-01-10",to:"2033-01-14"}),{...principal,principalType:"SUPPORT",piiMode:"MASKED"});
    assert.match(masked.spans.find(span=>span.reservation.id===ids.resA).reservation.first_name,/\*\*$/u);

    await run({action:"unassign_reservation_room",reservationId:ids.resA,expectedVersion:"3"},`board-unassign-${suffix}`);
    const [unassigned]=await sql`SELECT room_id,version,(SELECT COUNT(*)::int FROM reservation_nights WHERE reservation_id=${ids.resA}) physical,(SELECT COUNT(*)::int FROM reservation_type_nights WHERE reservation_id=${ids.resA}) typed FROM reservations WHERE id=${ids.resA}`;
    assert.deepEqual({room:unassigned.room_id,version:unassigned.version,physical:unassigned.physical,typed:unassigned.typed},{room:null,version:4,physical:0,typed:3});

    await sql`UPDATE reservations SET room_id=${ids.roomC} WHERE id=${ids.resC}`;
    await sql`INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) SELECT 'prop-seoul',${ids.resC},${ids.roomC},day::date FROM generate_series('2033-01-14'::date,'2033-01-15'::date,interval '1 day') day`;
    await assert.rejects(run({action:"unassign_reservation_room",reservationId:ids.resC,expectedVersion:"1"},`board-inhouse-${suffix}`),error=>error instanceof RoomAssignmentError&&error.message==="체크인된 예약은 배정 해제할 수 없습니다");

    const concurrent=await Promise.allSettled([
      run({action:"assign_reservation_room",reservationId:ids.resD,roomId:ids.roomC,expectedVersion:"1"},`board-race-d-${suffix}`),
      run({action:"assign_reservation_room",reservationId:ids.resE,roomId:ids.roomC,expectedVersion:"1"},`board-race-e-${suffix}`),
    ]);
    assert.equal(concurrent.filter(result=>result.status==="fulfilled").length,1);
    assert.equal(concurrent.filter(result=>result.status==="rejected"&&mapPmsError(result.reason?.message)?.status===409).length,1);
  }finally{
    await sql.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");for(const id of Object.values(ids).filter(value=>value.includes("-r"))){await tx`DELETE FROM worker_attempts WHERE property_id='prop-seoul' AND job_id IN (SELECT id FROM worker_jobs WHERE source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${id}))`;await tx`DELETE FROM worker_jobs WHERE property_id='prop-seoul' AND source_id IN (SELECT id FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${id})`;await tx`DELETE FROM outbox_events WHERE property_id='prop-seoul' AND aggregate_id=${id}`;}await tx`DELETE FROM room_moves WHERE property_id='prop-seoul' AND reservation_id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE})`;await tx`DELETE FROM reservation_mutations WHERE property_id='prop-seoul' AND reservation_id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE})`;await tx`DELETE FROM reservation_nights WHERE property_id='prop-seoul' AND reservation_id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE})`;await tx`DELETE FROM reservation_type_nights WHERE property_id='prop-seoul' AND reservation_id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE})`;await tx`DELETE FROM audit_logs WHERE property_id='prop-seoul' AND (actor=${actor} OR entity_id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE}))`;await tx`DELETE FROM reservations WHERE id IN (${ids.resA},${ids.resB},${ids.resC},${ids.resD},${ids.resE})`;await tx`DELETE FROM guests WHERE id IN (${ids.guestA},${ids.guestB},${ids.guestC},${ids.guestD},${ids.guestE})`;await tx`DELETE FROM rooms WHERE id IN (${ids.roomA},${ids.roomB},${ids.roomC},${ids.roomD})`;});
    for(const key of keys)await sql`DELETE FROM idempotency_keys WHERE property_id='prop-seoul' AND key=${key}`;
    await closePmsDatabase();await sql.end({timeout:2});
  }
});

test("staff price projection matches SQL for closed fallback, parent inheritance, occupancy and sale window",{skip},async()=>{
  const sql=client(3),suffix=crypto.randomUUID().slice(0,8),db=scopePmsDatabase(getPmsDatabase({DATABASE_URL:databaseUrl}),"prop-seoul"),parent=`it-price-parent-${suffix}`,child=`it-price-child-${suffix}`,outside=`it-price-outside-${suffix}`;
  try{
    await sql`INSERT INTO rate_plans(id,property_id,code,name,currency,base_occupancy,max_occupancy,pricing_model,adjustment,sort_order,created_at,updated_at,created_by,updated_by) VALUES
      (${parent},'prop-seoul',${`ITP-${suffix.toUpperCase()}`},'Parity Parent','KRW',2,4,'FIXED',0,90,now(),now(),'integration','integration'),
      (${child},'prop-seoul',${`ITC-${suffix.toUpperCase()}`},'Parity Child','KRW',2,4,'OFFSET',10000,91,now(),now(),'integration','integration'),
      (${outside},'prop-seoul',${`ITO-${suffix.toUpperCase()}`},'Outside Window','KRW',2,4,'FIXED',0,92,now(),now(),'integration','integration')`;
    await sql`UPDATE rate_plans SET parent_rate_plan_id=${parent} WHERE id=${child}`;
    await sql`UPDATE rate_plans SET sellable_from='2099-01-01T00:00:00Z',sellable_to='2099-12-31T23:59:59Z' WHERE id=${outside}`;
    await sql`INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by) VALUES
      ('prop-seoul',${parent},'rt-ste',100000,true,1,now(),'integration'),('prop-seoul',${child},'rt-ste',1,true,1,now(),'integration'),('prop-seoul',${outside},'rt-ste',500000,true,1,now(),'integration')`;
    await sql`INSERT INTO rate_plan_occupancy(property_id,rate_plan_id,occupancy,extra_charge,updated_by) VALUES ('prop-seoul',${child},3,30000,'integration')`;
    await sql`INSERT INTO rate_plan_calendar(id,property_id,rate_plan_id,room_type_id,stay_date,sell_rate,closed,updated_at,updated_by) VALUES
      (${`it-price-closed-${suffix}`},'prop-seoul',${parent},'rt-ste','2033-02-10',999999,true,now(),'integration'),
      (${`it-price-open-${suffix}`},'prop-seoul',${parent},'rt-ste','2033-02-11',200000,false,now(),'integration')`;
    const availability=await loadReservationAvailability(db,new URLSearchParams({arrival:"2033-02-10",departure:"2033-02-12",adults:"3",children:"0"}));
    const plan=availability.offers.find(item=>item.roomTypeId==="rt-ste")?.plans.find(item=>item.id===child);assert.ok(plan);
    const sqlRates=await sql`SELECT day::date stay_date,talos_effective_product_rate('prop-seoul',${child},'rt-ste',day::date,3)::numeric rate FROM generate_series('2033-02-10'::date,'2033-02-11'::date,interval '1 day') day ORDER BY day`;
    assert.deepEqual(plan.nights.map(row=>row.rate),sqlRates.map(row=>Number(row.rate)));
    assert.deepEqual(plan.nights.map(row=>row.rate),[140000,240000]);
    assert.equal(availability.offers.some(item=>item.plans.some(candidate=>candidate.id===outside)),false);
    const [overCapacity]=await sql`SELECT talos_effective_product_rate('prop-seoul',${child},'rt-ste','2033-02-10',5)::numeric rate`;assert.equal(overCapacity.rate,null);
  }finally{
    await sql`DELETE FROM rate_plan_calendar WHERE property_id='prop-seoul' AND rate_plan_id IN (${parent},${child},${outside})`;await sql`DELETE FROM rate_plan_occupancy WHERE property_id='prop-seoul' AND rate_plan_id IN (${parent},${child},${outside})`;await sql`DELETE FROM rate_plan_room_types WHERE property_id='prop-seoul' AND rate_plan_id IN (${parent},${child},${outside})`;await sql`DELETE FROM rate_plans WHERE property_id='prop-seoul' AND id IN (${parent},${child},${outside})`;await closePmsDatabase();await sql.end({timeout:2});
  }
});
