/** Behavioral contracts for registry-driven PMS command validation and errors. */
import test from "node:test";
import assert from "node:assert/strict";
import { actionRegistry, registrationFor } from "../app/api/pms/action-registry.ts";
import { mapPmsError } from "../app/api/pms/error-map.ts";

test("every registered action has one capability, domain, and Zod schema",()=>{
  assert.equal(actionRegistry.size,85);
  for(const [action,registration] of actionRegistry){
    assert.equal(registration.action,action);
    assert.ok(registration.capability);
    assert.ok(registration.domain);
    assert.equal(typeof registration.schema.safeParse({action}).success,"boolean");
  }
});

test("HotelStory banquet and member commands have closed required fields",()=>{
  assert.equal(registrationFor("upsert_banquet_reservation").schema.safeParse({action:"upsert_banquet_reservation",venueId:"v1",eventDate:"2031-01-02",startTime:"10:00",endTime:"12:00",eventName:"행사",contactName:"담당자",attendees:"30",fee:"100000"}).success,true);
  assert.equal(registrationFor("upsert_banquet_reservation").schema.safeParse({action:"upsert_banquet_reservation",venueId:"v1",eventDate:"01/02/2031"}).success,false);
  assert.equal(registrationFor("reset_hotel_member_password").capability,"USER_ADMIN");
  assert.equal(registrationFor("set_banquet_reservation_status").capability,"GROUP_WRITE");
});

test("room-board commands require optimistic version and server-owned move dates",()=>{
  const assign=registrationFor("assign_reservation_room"),move=registrationFor("move_reservation_room"),unassign=registrationFor("unassign_reservation_room");
  assert.equal(assign.capability,"RESERVATION_WRITE");
  assert.equal(move.capability,"RESERVATION_WRITE");
  assert.equal(unassign.capability,"RESERVATION_WRITE");
  assert.equal(assign.schema.safeParse({action:"assign_reservation_room",reservationId:"res-1",roomId:"room-1",expectedVersion:"1"}).success,true);
  assert.equal(move.schema.safeParse({action:"move_reservation_room",reservationId:"res-1",roomId:"room-2",moveDate:"2031-03-02",reason:"ROOM_BOARD",expectedVersion:"2"}).success,true);
  assert.equal(move.schema.safeParse({action:"move_reservation_room",reservationId:"res-1",roomId:"room-2",moveDate:"03/02/2031",expectedVersion:"2"}).success,false);
  assert.equal(unassign.schema.safeParse({action:"unassign_reservation_room",reservationId:"res-1"}).success,false);
});

test("Zod rejects malformed commands before a domain handler runs",()=>{
  const registration=registrationFor("create_reservation");
  assert.ok(registration);
  const invalid=registration.schema.safeParse({action:"create_reservation",arrivalDate:"17/07/2026"});
  assert.equal(invalid.success,false);
  const valid=registration.schema.safeParse({
    action:"create_reservation",firstName:"Aurora",lastName:"Guest",
    arrivalDate:"2026-08-01",departureDate:"2026-08-02",roomTypeId:"rt-dlx",
  });
  assert.equal(valid.success,true);
  assert.equal(registrationFor("raw_sql"),undefined);
});

test("channel settlement accepts the reservation-derived accounting contract",()=>{
  const registration=registrationFor("accrue_channel_settlement");
  assert.ok(registration);
  assert.equal(registration.schema.safeParse({
    action:"accrue_channel_settlement",
    connectionId:"connection-1",
    reservationId:"reservation-1",
  }).success,true);
  assert.equal(registration.schema.safeParse({
    action:"accrue_channel_settlement",
    connectionId:"connection-1",
  }).success,false);
});

test("channel deposit receipt and restoration use explicit accounting permissions",()=>{
  const receipt=registrationFor("mark_channel_settlement_paid"),restore=registrationFor("restore_channel_settlement_payment");
  assert.equal(receipt.capability,"ACCOUNTING_WRITE");
  assert.equal(restore.capability,"ACCOUNTING_WRITE");
  assert.equal(receipt.schema.safeParse({action:"mark_channel_settlement_paid",settlementId:"settlement-1",depositDate:"2031-01-01",memo:"Bank"}).success,true);
  assert.equal(restore.schema.safeParse({action:"restore_channel_settlement_payment",settlementId:"settlement-1",restoreDate:"2031-01-01",reason:"Mismatch"}).success,true);
  assert.equal(restore.schema.safeParse({action:"restore_channel_settlement_payment",settlementId:"settlement-1"}).success,false);
});

test("manual journals and reversals validate the payload used by the accounting UI",()=>{
  assert.equal(registrationFor("post_accounting_entry").schema.safeParse({
    action:"post_accounting_entry",businessDate:"2026-08-01",description:"Linen",
    debitAccountId:"expense-1",creditAccountId:"cash-1",amount:"25000",
  }).success,true);
  assert.equal(registrationFor("reverse_accounting_entry").schema.safeParse({
    action:"reverse_accounting_entry",entryId:"journal-1",reason:"Correction",
  }).success,true);
});

test("ARI dispatch validates the identifier emitted by the channel UI",()=>{
  assert.equal(registrationFor("dispatch_ari_update").schema.safeParse({
    action:"dispatch_ari_update",updateId:"ari-1",outcome:"ACK",
  }).success,true);
});

test("website image transport allows base64 expansion but rejects oversized payloads",()=>{
  const registration=registrationFor("upload_website_media");
  const prefix="data:image/png;base64,";
  assert.equal(registration.schema.safeParse({action:"upload_website_media",scope:"HOTEL",filename:"hero.png",dataUrl:prefix+"A".repeat(3_900_000)}).success,true);
  assert.equal(registration.schema.safeParse({action:"upload_website_media",scope:"HOTEL",filename:"hero.png",dataUrl:prefix+"A".repeat(4_200_000)}).success,false);
});

test("database errors map through a stable table instead of includes branches",()=>{
  assert.deepEqual(mapPmsError("duplicate key violates room_night_uq"),{
    status:409,error:"해당 객실은 그 날짜에 이미 배정되어 있습니다",
  });
  assert.deepEqual(mapPmsError('invalid input syntax for type integer: "RESERVATION_VERSION_CONFLICT_0"'),{
    status:409,error:"다른 사용자가 먼저 변경했습니다. 화면을 새로고침하세요.",
  });
  assert.deepEqual(mapPmsError('invalid input syntax for type integer: "ROOM_ASSIGNMENT_BLOCKED_0"'),{
    status:409,error:"판매 중지 객실은 배정할 수 없습니다.",
  });
  assert.deepEqual(mapPmsError('invalid input syntax for type integer: "ROOM_UNASSIGN_IN_HOUSE_0"'),{
    status:409,error:"체크인된 예약은 배정 해제할 수 없습니다",
  });
  assert.equal(mapPmsError("unexpected driver fault"),null);
  assert.equal(mapPmsError("receipt must match the current paid settlement journal")?.status,409);
  assert.equal(mapPmsError("banquet venue time slot overlaps an active reservation")?.status,409);
});
