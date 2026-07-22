/** Transactional physical-room assignment commands used by the room board. */
import type { PmsDatabase, PmsPreparedStatement } from "../../../db/pms-database";
import type { Principal } from "./auth";

type AssignmentAction =
  | "assign_reservation_room"
  | "move_reservation_room"
  | "unassign_reservation_room";

type ReservationRow = {
  id:string;room_id:string|null;room_type_id:string;arrival_date:string;departure_date:string;
  status:string;version:number;
};
type RoomRow = {
  id:string;room_type_id:string;number:string;housekeeping_status:string;active:boolean;
};

/** The gateway translates this typed domain failure without relying on text grep. */
export class RoomAssignmentError extends Error {
  constructor(message:string,readonly status=409){super(message);this.name="RoomAssignmentError";}
}

export const ROOM_ASSIGNMENT_ACTIONS = new Set<AssignmentAction>([
  "assign_reservation_room",
  "move_reservation_room",
  "unassign_reservation_room",
]);

function warningFlags(reservation:ReservationRow,room:RoomRow){
  return {
    roomTypeMismatch:room.room_type_id!==reservation.room_type_id,
    dirty:room.housekeeping_status==="DIRTY",
  };
}

async function reservationFor(db:PmsDatabase,id:string){
  return db.prepare(`SELECT id,room_id,room_type_id,arrival_date,departure_date,status,version
    FROM reservations WHERE property_id=pms_current_property_id() AND id=? LIMIT 1`).bind(id).first<ReservationRow>();
}

async function activeRoomFor(db:PmsDatabase,id:string){
  return db.prepare(`SELECT id,room_type_id,number,housekeeping_status,active
    FROM rooms WHERE property_id=pms_current_property_id() AND id=? AND active LIMIT 1`).bind(id).first<RoomRow>();
}

function receipt(db:PmsDatabase,key:string,action:string,actor:string,now:string){
  return db.prepare("INSERT INTO idempotency_keys VALUES (?,pms_current_property_id(),?,?,?)").bind(key,action,actor,now);
}

/** Locks the chosen room and rechecks the hard OOS gate in the write snapshot. */
function availableRoomGuard(db:PmsDatabase,roomId:string){
  return db.prepare(`SELECT CASE WHEN COUNT(*)=1 THEN 1
    ELSE ('ROOM_ASSIGNMENT_BLOCKED_'||COUNT(*)::text)::int END room_guard
    FROM (SELECT id FROM rooms WHERE property_id=pms_current_property_id() AND id=?
      AND active AND housekeeping_status<>'OUT_OF_SERVICE' FOR UPDATE) available_room`).bind(roomId);
}

/** Prevents an in-flight check-in from racing a physical-room unassignment. */
function unassignStatusGuard(db:PmsDatabase,reservationId:string){
  return db.prepare(`SELECT CASE WHEN COUNT(*)=1 THEN 1
    ELSE ('ROOM_UNASSIGN_IN_HOUSE_'||COUNT(*)::text)::int END status_guard
    FROM (SELECT id FROM reservations WHERE property_id=pms_current_property_id() AND id=?
      AND status<>'IN_HOUSE' FOR UPDATE) mutable_reservation`).bind(reservationId);
}

/**
 * Updates the reservation first and then asserts the affected version inside the
 * same transaction. A competing writer makes the aggregate-dependent ELSE branch
 * cast a named marker to integer; the gateway maps only that marker to a 409 and
 * PostgreSQL rolls every night/audit/receipt write back.
 */
function optimisticStatements(
  db:PmsDatabase,reservation:ReservationRow,kind:string,actor:string,now:string,update:PmsPreparedStatement,
){
  const expected=Number(reservation.version);
  return [
    db.prepare("INSERT INTO reservation_mutations VALUES (?,pms_current_property_id(),?,?,?, ?,?)")
      .bind(crypto.randomUUID(),reservation.id,expected,kind,actor,now),
    update,
    db.prepare(`SELECT CASE WHEN COUNT(*)=1 THEN 1
      ELSE ('RESERVATION_VERSION_CONFLICT_'||COUNT(*)::text)::int END version_guard
      FROM reservations WHERE property_id=pms_current_property_id() AND id=? AND version=?`)
      .bind(reservation.id,expected+1),
  ];
}

function assertMutableReservation(reservation:ReservationRow|null){
  if(!reservation)throw new RoomAssignmentError("예약을 찾지 못했습니다.",404);
  if(["CANCELLED","NO_SHOW","CHECKED_OUT"].includes(reservation.status))
    throw new RoomAssignmentError("종료되거나 취소된 예약의 객실 배정은 변경할 수 없습니다.");
}

function assertExpectedVersion(reservation:ReservationRow,raw:unknown){
  const expected=Number(raw);
  if(!Number.isInteger(expected)||expected!==Number(reservation.version))
    throw new RoomAssignmentError("다른 사용자가 먼저 변경했습니다. 화면을 새로고침하세요.");
}

function assertRoom(room:RoomRow|null){
  if(!room)throw new RoomAssignmentError("활성 객실을 찾지 못했습니다.",404);
  if(room.housekeeping_status==="OUT_OF_SERVICE")
    throw new RoomAssignmentError("판매 중지 객실은 배정할 수 없습니다.");
}

/**
 * Handles only board actions. `reservation_type_nights` is intentionally absent
 * from every statement: physical assignment can never consume/release type stock.
 */
export async function handleRoomAssignmentAction(
  db:PmsDatabase,body:Record<string,string>,principal:Principal,now:string,idempotencyKey:string,
){
  if(!ROOM_ASSIGNMENT_ACTIONS.has(body.action as AssignmentAction))return false;
  const reservation=await reservationFor(db,body.reservationId);
  assertMutableReservation(reservation);
  assertExpectedVersion(reservation!,body.expectedVersion);
  const actor=principal.email;

  if(body.action==="unassign_reservation_room"){
    if(reservation!.status==="IN_HOUSE")
      throw new RoomAssignmentError("체크인된 예약은 배정 해제할 수 없습니다");
    const before={roomId:reservation!.room_id,version:reservation!.version};
    const statements:PmsPreparedStatement[]=[
      unassignStatusGuard(db,reservation!.id),
      ...optimisticStatements(db,reservation!,"UNASSIGN_RESERVATION_ROOM",actor,now,
        db.prepare(`UPDATE reservations SET room_id=NULL,version=version+1,updated_at=?
          WHERE property_id=pms_current_property_id() AND id=? AND version=?`)
          .bind(now,reservation!.id,reservation!.version)),
      db.prepare("DELETE FROM reservation_nights WHERE property_id=pms_current_property_id() AND reservation_id=?").bind(reservation!.id),
      db.prepare(`INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'UNASSIGN_RESERVATION_ROOM','reservation',?,?,?,?)`)
        .bind(crypto.randomUUID(),actor,reservation!.id,before,{roomId:null,version:reservation!.version+1},now),
      db.prepare(`INSERT INTO outbox_events VALUES (?,pms_current_property_id(),'reservation.room_unassigned','reservation',?,?,'PENDING',0,?,NULL)`)
        .bind(crypto.randomUUID(),reservation!.id,{reservationId:reservation!.id},now),
      receipt(db,idempotencyKey,body.action,actor,now),
    ];
    await db.batch(statements);
    return true;
  }

  const room=await activeRoomFor(db,body.roomId);
  assertRoom(room);
  const warnings=warningFlags(reservation!,room!);
  if((warnings.roomTypeMismatch||warnings.dirty)&&body.warningOverride!=="true")
    throw new RoomAssignmentError("객실 타입 또는 청소 상태 경고를 확인해야 합니다.",400);

  if(body.action==="assign_reservation_room"){
    const before={roomId:reservation!.room_id,version:reservation!.version};
    const statements:PmsPreparedStatement[]=[
      availableRoomGuard(db,room!.id),
      ...optimisticStatements(db,reservation!,"ASSIGN_RESERVATION_ROOM",actor,now,
        db.prepare(`UPDATE reservations SET room_id=?,version=version+1,updated_at=?
          WHERE property_id=pms_current_property_id() AND id=? AND version=?`)
          .bind(room!.id,now,reservation!.id,reservation!.version)),
      db.prepare("DELETE FROM reservation_nights WHERE property_id=pms_current_property_id() AND reservation_id=?").bind(reservation!.id),
      db.prepare(`INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date)
        SELECT pms_current_property_id(),?,?,day::date
        FROM generate_series(?::date,(?::date-INTERVAL '1 day')::date,INTERVAL '1 day') day`)
        .bind(reservation!.id,room!.id,reservation!.arrival_date,reservation!.departure_date),
      db.prepare(`INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'ASSIGN_RESERVATION_ROOM','reservation',?,?,?,?)`)
        .bind(crypto.randomUUID(),actor,reservation!.id,before,{roomId:room!.id,roomNumber:room!.number,warnings,warningOverride:Boolean(warnings.roomTypeMismatch||warnings.dirty),version:reservation!.version+1},now),
      db.prepare(`INSERT INTO outbox_events VALUES (?,pms_current_property_id(),'reservation.room_assigned','reservation',?,?,'PENDING',0,?,NULL)`)
        .bind(crypto.randomUUID(),reservation!.id,{reservationId:reservation!.id,roomId:room!.id},now),
      receipt(db,idempotencyKey,body.action,actor,now),
    ];
    await db.batch(statements);
    return true;
  }

  const moveDate=body.moveDate;
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(moveDate)||moveDate<reservation!.arrival_date||moveDate>=reservation!.departure_date)
    throw new RoomAssignmentError("이동 시작일은 예약 숙박 기간 안이어야 합니다.",400);
  const [fromNight,property]=await Promise.all([
    db.prepare(`SELECT room_id FROM reservation_nights WHERE property_id=pms_current_property_id()
      AND reservation_id=? AND stay_date=? LIMIT 1`).bind(reservation!.id,moveDate).first<{room_id:string}>(),
    db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id() LIMIT 1").first<{business_date:string}>(),
  ]);
  if(!fromNight)throw new RoomAssignmentError("이동 시작일에 배정된 객실이 없습니다.");
  if(fromNight.room_id===room!.id)throw new RoomAssignmentError("현재 배정 객실과 다른 객실을 선택하세요.",400);
  const businessDate=String(property?.business_date||moveDate);
  // Before a future split, keep the currently representative room. Once the
  // business date reaches the split, the target room becomes representative.
  const representativeRoomId=businessDate>=moveDate&&businessDate<reservation!.departure_date
    ?room!.id:(reservation!.room_id||fromNight.room_id);
  const reason=(body.reason||"").trim().slice(0,120);
  if(!reason)throw new RoomAssignmentError("객실 이동 사유를 입력하세요.",400);
  const moveId=crypto.randomUUID(),notes=(body.notes||"").trim().slice(0,1000);
  const statements:PmsPreparedStatement[]=[
    availableRoomGuard(db,room!.id),
    ...optimisticStatements(db,reservation!,"MOVE_RESERVATION_ROOM",actor,now,
      db.prepare(`UPDATE reservations SET room_id=?,version=version+1,updated_at=?
        WHERE property_id=pms_current_property_id() AND id=? AND version=?`)
        .bind(representativeRoomId,now,reservation!.id,reservation!.version)),
    db.prepare(`DELETE FROM reservation_nights WHERE property_id=pms_current_property_id()
      AND reservation_id=? AND stay_date>=?`).bind(reservation!.id,moveDate),
    db.prepare(`INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date)
      SELECT pms_current_property_id(),?,?,day::date
      FROM generate_series(?::date,(?::date-INTERVAL '1 day')::date,INTERVAL '1 day') day`)
      .bind(reservation!.id,room!.id,moveDate,reservation!.departure_date),
    db.prepare(`INSERT INTO room_moves(id,property_id,reservation_id,from_room_id,to_room_id,move_date,reason,notes,actor,created_at)
      VALUES (?,pms_current_property_id(),?,?,?,?,?,?,?,?)`)
      .bind(moveId,reservation!.id,fromNight.room_id,room!.id,moveDate,reason,notes,actor,now),
    db.prepare(`INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'MOVE_RESERVATION_ROOM','reservation',?,?,?,?)`)
      .bind(crypto.randomUUID(),actor,reservation!.id,{roomId:fromNight.room_id,moveDate,version:reservation!.version},{roomId:room!.id,representativeRoomId,moveDate,reason,warnings,warningOverride:Boolean(warnings.roomTypeMismatch||warnings.dirty),version:reservation!.version+1},now),
    db.prepare(`INSERT INTO outbox_events VALUES (?,pms_current_property_id(),'reservation.room_moved','reservation',?,?,'PENDING',0,?,NULL)`)
      .bind(crypto.randomUUID(),reservation!.id,{reservationId:reservation!.id,fromRoomId:fromNight.room_id,toRoomId:room!.id,moveDate},now),
    receipt(db,idempotencyKey,body.action,actor,now),
  ];
  await db.batch(statements);
  return true;
}
