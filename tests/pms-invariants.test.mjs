import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);
async function database() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0000_brief_bill_hollister.sql", "0001_aspiring_sentry.sql", "0002_mixed_kang.sql", "0003_financial_integrity.sql", "0004_married_guardsmen.sql", "0005_normal_frightful_four.sql"]) {
    const sql = await readFile(new URL(`drizzle/${name}`, root), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean)) db.exec(statement);
  }
  db.exec(`CREATE TRIGGER reservation_type_nights_capacity BEFORE INSERT ON reservation_type_nights BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT closed FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),0)=1 THEN RAISE(ABORT, 'room type closed')
      WHEN (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date) >= COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date), (SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out')
    END;
  END`);
  db.exec("CREATE TRIGGER inventory_controls_validate_insert BEFORE INSERT ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
  db.exec("CREATE TRIGGER inventory_controls_validate_update BEFORE UPDATE ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END");
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
