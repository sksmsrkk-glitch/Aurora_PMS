/** Behavioral contracts for registry-driven PMS command validation and errors. */
import test from "node:test";
import assert from "node:assert/strict";
import { actionRegistry, registrationFor } from "../app/api/pms/action-registry.ts";
import { mapPmsError } from "../app/api/pms/error-map.ts";

test("every registered action has one capability, domain, and Zod schema",()=>{
  assert.equal(actionRegistry.size,76);
  for(const [action,registration] of actionRegistry){
    assert.equal(registration.action,action);
    assert.ok(registration.capability);
    assert.ok(registration.domain);
    assert.equal(typeof registration.schema.safeParse({action}).success,"boolean");
  }
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
    status:409,error:"선택한 객실은 해당 일정에 이미 예약되어 있습니다. 다른 객실을 선택하세요.",
  });
  assert.equal(mapPmsError("unexpected driver fault"),null);
  assert.equal(mapPmsError("receipt must match the current paid settlement journal")?.status,409);
});
