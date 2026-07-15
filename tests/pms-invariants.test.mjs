import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);
async function database() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0000_brief_bill_hollister.sql", "0001_aspiring_sentry.sql", "0002_mixed_kang.sql", "0003_financial_integrity.sql", "0004_married_guardsmen.sql", "0005_normal_frightful_four.sql", "0006_quiet_wasp.sql", "0007_overconfident_whizzer.sql"]) {
    const sql = await readFile(new URL(`drizzle/${name}`, root), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean)) db.exec(statement);
  }
  db.exec(`CREATE TRIGGER reservation_type_nights_capacity BEFORE INSERT ON reservation_type_nights BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT closed FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),0)=1 THEN RAISE(ABORT, 'room type closed')
      WHEN (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date) + COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0) >= COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date), (SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out')
    END;
  END`);
  db.exec("CREATE TRIGGER inventory_controls_validate_insert BEFORE INSERT ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
  db.exec("CREATE TRIGGER inventory_controls_validate_update BEFORE UPDATE ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
  db.exec(`CREATE TRIGGER block_inventory_capacity_insert BEFORE INSERT ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`);
  db.exec(`CREATE TRIGGER block_inventory_capacity_update BEFORE UPDATE ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bi.id<>OLD.id AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`);
  db.exec("CREATE TRIGGER block_pickup_validate BEFORE INSERT ON block_pickup_nights WHEN NOT EXISTS (SELECT 1 FROM block_inventory WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date AND picked_up<current_rooms) BEGIN SELECT RAISE(ABORT, 'block allocation exhausted'); END");
  db.exec("CREATE TRIGGER block_pickup_increment AFTER INSERT ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=picked_up+1 WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date; END");
  db.exec("CREATE TRIGGER block_pickup_decrement AFTER DELETE ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=MAX(0,picked_up-1) WHERE block_id=OLD.block_id AND room_type_id=OLD.room_type_id AND stay_date=OLD.stay_date; END");
  db.exec("DROP TRIGGER IF EXISTS folio_entries_validate_insert");
  db.exec("CREATE TRIGGER folio_entries_validate_insert BEFORE INSERT ON folio_entries WHEN NEW.amount<=0 OR NEW.kind NOT IN ('CHARGE','PAYMENT','CHARGE_REVERSAL','PAYMENT_REVERSAL','REFUND') BEGIN SELECT RAISE(ABORT,'invalid folio entry'); END");
  db.exec("CREATE TRIGGER folio_details_validate_insert BEFORE INSERT ON folio_entry_details WHEN NEW.net_amount<0 OR NEW.tax_amount<0 OR NEW.service_amount<0 OR ABS((NEW.net_amount+NEW.tax_amount+NEW.service_amount)-(SELECT amount FROM folio_entries WHERE id=NEW.entry_id))>0.011 OR NOT EXISTS (SELECT 1 FROM folio_windows WHERE id=NEW.folio_window_id AND reservation_id=NEW.reservation_id AND status='OPEN') BEGIN SELECT RAISE(ABORT,'invalid folio detail'); END");
  db.exec("CREATE TRIGGER folio_details_no_update BEFORE UPDATE ON folio_entry_details BEGIN SELECT RAISE(ABORT,'folio details are immutable'); END");
  db.exec("CREATE TRIGGER folio_details_no_delete BEFORE DELETE ON folio_entry_details BEGIN SELECT RAISE(ABORT,'folio details are immutable'); END");
  db.exec("CREATE TRIGGER ar_ledger_validate_insert BEFORE INSERT ON ar_ledger_entries WHEN NEW.debit<0 OR NEW.credit<0 OR (NEW.debit=0 AND NEW.credit=0) OR (NEW.debit>0 AND NEW.credit>0) BEGIN SELECT RAISE(ABORT,'invalid ar ledger entry'); END");
  db.exec("CREATE TRIGGER ar_ledger_no_update BEFORE UPDATE ON ar_ledger_entries BEGIN SELECT RAISE(ABORT,'ar ledger entries are immutable'); END");
  db.exec("CREATE TRIGGER ar_ledger_no_delete BEFORE DELETE ON ar_ledger_entries BEGIN SELECT RAISE(ABORT,'ar ledger entries are immutable'); END");
  return db;
}

test("physical room inventory prevents double booking for the same night", async () => {
  const db = await database();
  db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (?,?,?,?)").run("p1","r1","room-101","2026-08-01");
  assert.throws(() => db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (?,?,?,?)").run("p1","r2","room-101","2026-08-01"), /UNIQUE constraint failed/);
  db.close();
});

test("only one open cashier session is allowed per actor", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO cashier_sessions(id,property_id,actor,business_date,status,opening_amount,opened_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("c1","p1","agent@hotel.test","2026-08-01","OPEN",50000,"2026-08-01T08:00:00Z");
  assert.throws(() => insert.run("c2","p1","agent@hotel.test","2026-08-01","OPEN",0,"2026-08-01T09:00:00Z"), /UNIQUE constraint failed/);
  insert.run("c3","p1","agent@hotel.test","2026-08-01","CLOSED",0,"2026-08-01T07:00:00Z");
  db.close();
});

test("a business date can be closed exactly once", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO night_audits(id,property_id,business_date,status,blockers_json,started_at) VALUES (?,?,?,?,?,?)");
  insert.run("a1","p1","2026-08-01","COMPLETED","[]","2026-08-02T00:00:00Z");
  assert.throws(() => insert.run("a2","p1","2026-08-01","COMPLETED","[]","2026-08-02T00:01:00Z"), /UNIQUE constraint failed/);
  db.close();
});

test("folio is append-only and its balance is charge minus payment", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,business_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insert.run("f1","p1","r1","CHARGE","ROOM","Room",220000,"2026-08-01","2026-08-01T00:00:00Z","audit");
  insert.run("f2","p1","r1","PAYMENT","PAYMENT","Card",200000,"2026-08-01","2026-08-01T00:01:00Z","cashier");
  const { balance } = db.prepare("SELECT SUM(CASE WHEN kind='CHARGE' THEN amount WHEN kind='PAYMENT' THEN -amount ELSE 0 END) balance FROM folio_entries WHERE reservation_id=?").get("r1");
  assert.equal(balance, 20000);
  assert.throws(() => db.prepare("UPDATE folio_entries SET amount=1 WHERE id='f1'").run(), /folio entries are immutable/);
  assert.throws(() => db.prepare("DELETE FROM folio_entries WHERE id='f1'").run(), /folio entries are immutable/);
  assert.throws(() => insert.run("f3","p1","r1","PAYMENT","PAYMENT","Invalid",-1,"2026-08-01","2026-08-01T00:02:00Z","cashier"), /invalid folio entry/);
  db.close();
});

test("each property has one active assignment row per user", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO role_assignments(id,property_id,email,role,active,created_at) VALUES (?,?,?,?,?,?)");
  insert.run("u1","p1","user@hotel.test","FRONT_DESK",1,"2026-08-01T00:00:00Z");
  assert.throws(() => insert.run("u2","p1","user@hotel.test","PROPERTY_ADMIN",1,"2026-08-01T00:01:00Z"), /UNIQUE constraint failed/);
  db.close();
});

test("only one worker can consume a reservation state transition", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO reservation_transitions(id,property_id,reservation_id,from_status,to_status,actor,created_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("t1","p1","r1","DUE_IN","IN_HOUSE","frontdesk-a","2026-08-01T10:00:00Z");
  assert.throws(() => insert.run("t2","p1","r1","DUE_IN","NO_SHOW","frontdesk-b","2026-08-01T10:00:00Z"), /UNIQUE constraint failed/);
  insert.run("t3","p1","r1","IN_HOUSE","CHECKED_OUT","frontdesk-b","2026-08-02T10:00:00Z");
  db.close();
});

test("room-type night inventory prevents overbooking and releases atomically", async () => {
  const db = await database();
  const room = db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,version) VALUES (?,?,?,?,?,?,?,?,?)");
  room.run("room-1","p1","rt1","101",1,"VACANT","CLEAN","[]",1);
  room.run("room-2","p1","rt1","102",1,"VACANT","CLEAN","[]",1);
  const night = db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (?,?,?,?)");
  night.run("p1","r1","rt1","2026-08-01"); night.run("p1","r2","rt1","2026-08-01");
  assert.throws(() => night.run("p1","r3","rt1","2026-08-01"), /room type sold out/);
  db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id='r1'").run();
  night.run("p1","r3","rt1","2026-08-01");
  db.close();
});

test("closed inventory rejects arrivals and stale reservation versions lose", async () => {
  const db = await database();
  db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,version) VALUES (?,?,?,?,?,?,?,?,?)").run("room-1","p1","rt1","101",1,"VACANT","CLEAN","[]",1);
  db.prepare("INSERT INTO inventory_controls(id,property_id,room_type_id,stay_date,sell_limit,closed,min_stay,close_to_arrival,close_to_departure,price_override,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("i1","p1","rt1","2026-08-01",1,1,1,0,0,220000,"2026-07-01","revenue");
  assert.throws(() => db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (?,?,?,?)").run("p1","r1","rt1","2026-08-01"), /room type closed/);
  const mutation=db.prepare("INSERT INTO reservation_mutations(id,property_id,reservation_id,expected_version,kind,actor,created_at) VALUES (?,?,?,?,?,?,?)");
  mutation.run("m1","p1","r1",4,"EDIT","agent-a","2026-08-01T00:00:00Z");
  assert.throws(() => mutation.run("m2","p1","r1",4,"ASSIGN_ROOM","agent-b","2026-08-01T00:00:01Z"), /UNIQUE constraint failed/);
  db.close();
});

test("deduct blocks hold house inventory and pickup converts hold to reservation", async () => {
  const db=await database();
  const room=db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,version) VALUES (?,?,?,?,?,?,?,?,?)");
  for(let index=1;index<=3;index++) room.run(`room-${index}`,"p1","rt1",String(100+index),1,"VACANT","CLEAN","[]",1);
  const reservationNight=db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (?,?,?,?)");
  reservationNight.run("p1","direct-1","rt1","2026-08-01");
  db.prepare("INSERT INTO business_blocks(id,property_id,code,name,arrival_date,departure_date,status,reservation_method,deduct_inventory,currency,notes,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("b1","p1","B1","Group","2026-08-01","2026-08-02","DEFINITE","ROOMING_LIST",1,"KRW","",1,"2026-07-01","2026-07-01");
  db.prepare("INSERT INTO block_inventory(id,property_id,block_id,room_type_id,stay_date,original_rooms,current_rooms,picked_up,rate,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("bi1","p1","b1","rt1","2026-08-01",2,2,0,190000,1,"2026-07-01");
  assert.throws(()=>reservationNight.run("p1","direct-2","rt1","2026-08-01"),/room type sold out/);
  const pickup=db.prepare("INSERT INTO block_pickup_nights(property_id,block_id,rooming_entry_id,room_type_id,stay_date,created_at) VALUES (?,?,?,?,?,?)");
  pickup.run("p1","b1","entry-1","rt1","2026-08-01","2026-07-01"); reservationNight.run("p1","group-1","rt1","2026-08-01");
  pickup.run("p1","b1","entry-2","rt1","2026-08-01","2026-07-01"); reservationNight.run("p1","group-2","rt1","2026-08-01");
  assert.equal(db.prepare("SELECT picked_up FROM block_inventory WHERE id='bi1'").get().picked_up,2);
  assert.throws(()=>pickup.run("p1","b1","entry-3","rt1","2026-08-01","2026-07-01"),/block allocation exhausted/);
  db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id='group-1'").run(); db.prepare("DELETE FROM block_pickup_nights WHERE rooming_entry_id='entry-1'").run();
  assert.equal(db.prepare("SELECT picked_up FROM block_inventory WHERE id='bi1'").get().picked_up,1);
  assert.throws(()=>reservationNight.run("p1","direct-3","rt1","2026-08-01"),/room type sold out/);
  db.close();
});

test("folio split uses append-only reversal and preserves tax totals", async () => {
  const db=await database(),entry=db.prepare("INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,business_date,created_at,created_by,reverses_entry_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),detail=db.prepare("INSERT INTO folio_entry_details(entry_id,property_id,reservation_id,folio_window_id,net_amount,tax_amount,service_amount,currency,source_entry_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  db.prepare("INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,status,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)").run("w1","p1","r1",1,"Guest","GUEST","OPEN","2026-08-01","cashier");
  db.prepare("INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,status,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)").run("w2","p1","r1",2,"Company","COMPANY","OPEN","2026-08-01","cashier");
  entry.run("f1","p1","r1","CHARGE","FNB","Dinner",120000,"2026-08-01","2026-08-01T10:00:00Z","cashier",null); detail.run("f1","p1","r1","w1",100000,10000,10000,"KRW",null,null,"2026-08-01T10:00:00Z");
  entry.run("f2","p1","r1","CHARGE_REVERSAL","FNB","Split reversal",60000,"2026-08-01","2026-08-01T10:01:00Z","cashier","f1"); detail.run("f2","p1","r1","w1",50000,5000,5000,"KRW","f1","SPLIT","2026-08-01T10:01:00Z");
  entry.run("f3","p1","r1","CHARGE","FNB","Split repost",60000,"2026-08-01","2026-08-01T10:01:00Z","cashier",null); detail.run("f3","p1","r1","w2",50000,5000,5000,"KRW","f1","SPLIT","2026-08-01T10:01:00Z");
  const balance=db.prepare("SELECT SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'CHARGE_REVERSAL' THEN -amount ELSE 0 END) balance FROM folio_entries WHERE reservation_id='r1'").get().balance,components=db.prepare("SELECT SUM(CASE f.kind WHEN 'CHARGE' THEN d.net_amount+d.tax_amount+d.service_amount WHEN 'CHARGE_REVERSAL' THEN -(d.net_amount+d.tax_amount+d.service_amount) ELSE 0 END) total FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id").get().total;
  assert.equal(balance,120000);assert.equal(components,120000);assert.throws(()=>db.prepare("UPDATE folio_entry_details SET tax_amount=0 WHERE entry_id='f1'").run(),/folio details are immutable/);db.close();
});

test("AR transfer keeps guest plus receivable control total and ledger immutable", async () => {
  const db=await database();
  db.prepare("INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,business_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)").run("c1","p1","r1","CHARGE","ROOM","Room",220000,"2026-08-01","2026-08-01","audit");
  db.prepare("INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,payment_method,business_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("p1","p1","r1","PAYMENT","DIRECT_BILL","AR transfer",220000,"DIRECT_BILL","2026-08-01","2026-08-01","cashier");
  db.prepare("INSERT INTO ar_accounts(id,property_id,account_profile_id,account_no,name,credit_limit,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("ar1","p1","ap1","CORP1","Company",0,"ACTIVE","2026-08-01","2026-08-01");
  db.prepare("INSERT INTO ar_ledger_entries(id,property_id,ar_account_id,invoice_id,kind,debit,credit,business_date,memo,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("l1","p1","ar1","i1","INVOICE",220000,0,"2026-08-01","invoice","2026-08-01","cashier");
  const guest=db.prepare("SELECT SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount ELSE 0 END) balance FROM folio_entries").get().balance,ar=db.prepare("SELECT SUM(debit-credit) balance FROM ar_ledger_entries").get().balance;assert.equal(guest,0);assert.equal(ar,220000);assert.equal(guest+ar,220000);
  assert.throws(()=>db.prepare("UPDATE ar_ledger_entries SET credit=1 WHERE id='l1'").run(),/ar ledger entries are immutable/);db.close();
});
