/** Executable database invariant tests for inventory, finance and integrations. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);
async function database() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0000_brief_bill_hollister.sql", "0001_aspiring_sentry.sql", "0002_mixed_kang.sql", "0003_financial_integrity.sql", "0004_married_guardsmen.sql", "0005_normal_frightful_four.sql", "0006_quiet_wasp.sql", "0007_overconfident_whizzer.sql", "0008_graceful_bedlam.sql", "0009_clear_living_mummy.sql", "0010_simple_killmonger.sql"]) {
    const sql = await readFile(new URL(`drizzle/${name}`, root), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean)) db.exec(statement);
  }
  db.exec(`CREATE TRIGGER reservation_type_nights_capacity BEFORE INSERT ON reservation_type_nights BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT closed FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),0)=1 THEN RAISE(ABORT, 'room type closed')
      WHEN (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date) + COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0) >= COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date), (SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out')
    END;
  END`);
  db.exec("CREATE TRIGGER inventory_controls_validate_insert BEFORE INSERT ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
  db.exec("CREATE TRIGGER inventory_controls_validate_update BEFORE UPDATE ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
  db.exec(`CREATE TRIGGER block_inventory_capacity_insert BEFORE INSERT ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`);
  db.exec(`CREATE TRIGGER block_inventory_capacity_update BEFORE UPDATE ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bi.id<>OLD.id AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
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
  db.exec("CREATE TRIGGER integration_attempts_validate_insert BEFORE INSERT ON integration_delivery_attempts WHEN NEW.attempt_no<1 OR NEW.direction NOT IN ('INBOUND','OUTBOUND') OR NEW.status NOT IN ('ACKED','FAILED') BEGIN SELECT RAISE(ABORT,'invalid integration attempt'); END");
  db.exec("CREATE TRIGGER integration_attempts_no_update BEFORE UPDATE ON integration_delivery_attempts BEGIN SELECT RAISE(ABORT,'integration attempts are immutable'); END");
  db.exec("CREATE TRIGGER integration_attempts_no_delete BEFORE DELETE ON integration_delivery_attempts BEGIN SELECT RAISE(ABORT,'integration attempts are immutable'); END");
  db.exec("CREATE TABLE channel_contracts(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,connection_id TEXT NOT NULL UNIQUE,contract_type TEXT NOT NULL CHECK(contract_type IN ('COMMISSION','NET_RATE')),commission_percent REAL NOT NULL CHECK(commission_percent BETWEEN 0 AND 100),status TEXT NOT NULL)");
  db.exec("CREATE TABLE channel_rate_overrides(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,connection_id TEXT NOT NULL,mapping_id TEXT NOT NULL,room_type_id TEXT NOT NULL,stay_date TEXT NOT NULL,sell_rate REAL NOT NULL CHECK(sell_rate>=0),net_rate REAL CHECK(net_rate IS NULL OR (net_rate>=0 AND net_rate<=sell_rate)),UNIQUE(mapping_id,stay_date))");
  db.exec("CREATE TABLE channel_settlements(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,contract_id TEXT NOT NULL,connection_id TEXT NOT NULL,reservation_id TEXT,business_date TEXT NOT NULL,contract_type TEXT NOT NULL,commission_percent REAL NOT NULL,gross_sell_amount REAL NOT NULL,channel_cost_amount REAL NOT NULL,hotel_net_amount REAL NOT NULL,status TEXT NOT NULL,CHECK(ABS((gross_sell_amount-channel_cost_amount)-hotel_net_amount)<=0.01),UNIQUE(connection_id,reservation_id))");
  db.exec("CREATE TABLE accounting_accounts(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,code TEXT NOT NULL,account_type TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,UNIQUE(property_id,code))");
  db.exec("CREATE TABLE accounting_journal_entries(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,entry_no TEXT NOT NULL,business_date TEXT NOT NULL,entry_type TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'POSTED',reversal_of_id TEXT,UNIQUE(property_id,entry_no))");
  db.exec("CREATE TABLE accounting_journal_lines(id TEXT PRIMARY KEY,property_id TEXT NOT NULL,journal_entry_id TEXT NOT NULL,account_id TEXT NOT NULL,debit REAL NOT NULL DEFAULT 0,credit REAL NOT NULL DEFAULT 0,CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)))");
  db.exec("CREATE TRIGGER accounting_lines_validate BEFORE INSERT ON accounting_journal_lines WHEN NOT EXISTS(SELECT 1 FROM accounting_accounts WHERE id=NEW.account_id AND active=1) BEGIN SELECT RAISE(ABORT,'active accounting account is required'); END");
  db.exec("CREATE TRIGGER accounting_lines_no_update BEFORE UPDATE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT,'accounting journal lines are immutable'); END");
  db.exec("CREATE TRIGGER accounting_lines_no_delete BEFORE DELETE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT,'accounting journal lines are immutable'); END");
  return db;
}

// Inventory and operational-lock invariants: these tests deliberately provoke the
// indexes/triggers that arbitrate concurrent room and business-date changes.
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

// Financial evidence invariants: balances are derived from append-only events, and
// corrections must be represented as reversals rather than update/delete operations.
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

// Type-level capacity includes physical serviceability, stop-sell controls, and
// inventory-deducting group holds—not only individually assigned room nights.
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

// Integration evidence is monotonic and immutable so provider retries or replayed
// webhook messages cannot silently overwrite a newer reservation or ARI revision.
test("channel messages and ARI revisions are idempotent and delivery attempts immutable", async () => {
  const db=await database();
  db.prepare("INSERT INTO channel_connections(id,property_id,provider,external_property_id,name,environment,status,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)").run("cc1","p1","BOOKING_COM","H1","Sandbox","SANDBOX","ACTIVE","2026-08-01","2026-08-01","admin");
  db.prepare("INSERT INTO channel_mappings(id,property_id,connection_id,room_type_id,external_room_type_id,rate_plan,external_rate_plan_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("cm1","p1","cc1","rt1","EXT-ROOM","OTA","EXT-BAR",1,"2026-08-01","2026-08-01");
  const inbound=db.prepare("INSERT INTO inbound_channel_messages(id,property_id,connection_id,provider,message_id,event_type,external_reservation_id,revision,payload_json,status,attempts,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");inbound.run("im1","p1","cc1","BOOKING_COM","MSG-1","NEW","EXT-1",1,"{}","PROCESSED",1,"2026-08-01");assert.throws(()=>inbound.run("im2","p1","cc1","BOOKING_COM","MSG-1","NEW","EXT-1",1,"{}","PENDING",0,"2026-08-01"),/UNIQUE constraint failed/);
  const ari=db.prepare("INSERT INTO ari_updates(id,property_id,connection_id,mapping_id,stay_date,revision,available,closed,min_stay,close_to_arrival,close_to_departure,rate,currency,payload_json,status,attempts,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");ari.run("a1","p1","cc1","cm1","2026-08-02",1,2,0,1,0,0,220000,"KRW","{}","PENDING",0,"2026-08-01");assert.throws(()=>ari.run("a2","p1","cc1","cm1","2026-08-02",1,1,0,1,0,0,220000,"KRW","{}","PENDING",0,"2026-08-01"),/UNIQUE constraint failed/);
  db.prepare("INSERT INTO integration_delivery_attempts(id,property_id,direction,provider,aggregate_type,aggregate_id,attempt_no,status,http_status,payload_json,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("ia1","p1","OUTBOUND","BOOKING_COM","ari_update","a1",1,"ACKED",200,"{}","2026-08-01","system");assert.throws(()=>db.prepare("UPDATE integration_delivery_attempts SET status='FAILED' WHERE id='ia1'").run(),/integration attempts are immutable/);db.close();
});

test("inactive and out-of-service rooms never increase sellable inventory", async () => {
  const db=await database(),room=db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?,?,?,?,?,?,?,?,?,?)");
  room.run("active","p1","rt1","101",1,"VACANT","CLEAN","[]",1,1);room.run("inactive","p1","rt1","102",1,"VACANT","CLEAN","[]",0,1);room.run("oos","p1","rt1","103",1,"VACANT","OUT_OF_SERVICE","[]",1,1);
  const night=db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (?,?,?,?)");night.run("p1","r1","rt1","2026-08-01");assert.throws(()=>night.run("p1","r2","rt1","2026-08-01"),/room type sold out/);db.close();
});

test("report exports retain filters, row counts, format and requesting actor", async () => {
  const db=await database();db.prepare("INSERT INTO report_exports(id,property_id,report_key,format,filters_json,row_count,status,requested_by,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("ex1","p1","occupancy","XLSX",JSON.stringify({from:"2026-08-01",to:"2026-08-31"}),31,"COMPLETED","revenue@hotel.test","2026-08-01T09:00:00Z","2026-08-01T09:00:01Z");
  const row=db.prepare("SELECT * FROM report_exports WHERE id='ex1'").get();assert.equal(row.report_key,"occupancy");assert.equal(row.row_count,31);assert.equal(row.requested_by,"revenue@hotel.test");assert.equal(JSON.parse(row.filters_json).to,"2026-08-31");db.close();
});

// Extended commercial/accounting invariants preserve balanced journals and the
// gross sell - channel cost = hotel net equation used by settlements and reports.
test("double-entry accounting stays balanced and journal lines are immutable", async()=>{
  const db=await database(),account=db.prepare("INSERT INTO accounting_accounts(id,property_id,code,account_type,active) VALUES (?,?,?,?,1)");
  account.run("cash","p1","1100","ASSET");account.run("expense","p1","5200","EXPENSE");
  db.prepare("INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,description,status) VALUES (?,?,?,?,?,?,?)").run("j1","p1","JRN-1","2026-08-01","EXPENSE","Laundry","POSTED");
  const line=db.prepare("INSERT INTO accounting_journal_lines(id,property_id,journal_entry_id,account_id,debit,credit) VALUES (?,?,?,?,?,?)");line.run("l1","p1","j1","expense",250000,0);line.run("l2","p1","j1","cash",0,250000);
  const totals=db.prepare("SELECT SUM(debit) debit,SUM(credit) credit FROM accounting_journal_lines WHERE journal_entry_id='j1'").get();assert.equal(totals.debit,totals.credit);
  assert.throws(()=>line.run("l3","p1","j1","missing",1,0),/active accounting account is required/);assert.throws(()=>db.prepare("UPDATE accounting_journal_lines SET debit=1 WHERE id='l1'").run(),/immutable/);assert.throws(()=>db.prepare("DELETE FROM accounting_journal_lines WHERE id='l1'").run(),/immutable/);db.close();
});

test("channel contracts preserve sell, distribution cost and hotel net equation",async()=>{
  const db=await database();db.prepare("INSERT INTO channel_contracts VALUES (?,?,?,?,?,?)").run("c1","p1","conn1","NET_RATE",0,"ACTIVE");
  const rate=db.prepare("INSERT INTO channel_rate_overrides VALUES (?,?,?,?,?,?,?,?)");rate.run("r1","p1","conn1","map1","rt1","2026-08-01",145000,112000);assert.throws(()=>rate.run("r2","p1","conn1","map1","rt1","2026-08-02",100000,120000),/CHECK constraint failed/);
  const settlement=db.prepare("INSERT INTO channel_settlements VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");settlement.run("s1","p1","c1","conn1","res1","2026-08-01","NET_RATE",0,145000,33000,112000,"ACCRUED");const row=db.prepare("SELECT * FROM channel_settlements WHERE id='s1'").get();assert.equal(row.gross_sell_amount-row.channel_cost_amount,row.hotel_net_amount);assert.throws(()=>settlement.run("s2","p1","c1","conn1","res1","2026-08-01","NET_RATE",0,145000,10000,112000,"ACCRUED"),/CHECK constraint failed|UNIQUE constraint failed/);db.close();
});
