import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";
type D1 = typeof env.DB;
type Role = "PROPERTY_ADMIN" | "NIGHT_AUDITOR" | "FRONT_DESK" | "CASHIER" | "HOUSEKEEPING" | "REVENUE_MANAGER" | "SALES_MANAGER" | "VIEWER";
type Principal = { email: string; displayName: string; role: Role; capabilities: string[] };

const roleCapabilities: Record<Role, string[]> = {
  PROPERTY_ADMIN: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "HOUSEKEEPING_WRITE", "CASHIER_WRITE", "EOD_RUN", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "ADMIN"],
  NIGHT_AUDITOR: ["READ", "FOLIO_WRITE", "CASHIER_WRITE", "EOD_RUN"],
  FRONT_DESK: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE", "GROUP_PICKUP"],
  CASHIER: ["READ", "FOLIO_WRITE", "CASHIER_WRITE"],
  HOUSEKEEPING: ["READ", "HOUSEKEEPING_WRITE"],
  REVENUE_MANAGER: ["READ", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP"],
  SALES_MANAGER: ["READ", "RESERVATION_WRITE", "GROUP_WRITE", "GROUP_PICKUP"],
  VIEWER: ["READ"],
};

const actionCapability: Record<string, string> = {
  create_reservation: "RESERVATION_WRITE", mark_no_show: "STAY_WRITE", check_in: "STAY_WRITE", check_out: "STAY_WRITE",
  edit_reservation: "RESERVATION_WRITE", cancel_reservation: "RESERVATION_WRITE", assign_room: "RESERVATION_WRITE", move_room: "STAY_WRITE",
  update_inventory_control: "INVENTORY_WRITE",
  create_account_profile: "GROUP_WRITE", create_business_block: "GROUP_WRITE", update_block_inventory: "GROUP_WRITE", add_rooming_entry: "GROUP_WRITE", cutoff_block: "GROUP_WRITE",
  pickup_rooming_entry: "GROUP_PICKUP",
  post_payment: "FOLIO_WRITE", post_charge: "FOLIO_WRITE", housekeeping: "HOUSEKEEPING_WRITE",
  open_cashier: "CASHIER_WRITE", close_cashier: "CASHIER_WRITE", run_night_audit: "EOD_RUN",
};

let initialization: Promise<void> | null = null;

const schema = [
  `CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, timezone TEXT NOT NULL, currency TEXT NOT NULL, business_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS room_types (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, base_rate REAL NOT NULL, capacity INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_type_id TEXT NOT NULL, number TEXT NOT NULL, floor INTEGER NOT NULL, front_desk_status TEXT NOT NULL, housekeeping_status TEXT NOT NULL, features TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, vip_level TEXT NOT NULL DEFAULT 'NONE', nationality TEXT, preferences TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, confirmation_no TEXT NOT NULL, property_id TEXT NOT NULL, guest_id TEXT NOT NULL, room_type_id TEXT NOT NULL, room_id TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, status TEXT NOT NULL, adults INTEGER NOT NULL, children INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, rate_plan TEXT NOT NULL, nightly_rate REAL NOT NULL, eta TEXT, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, room_id TEXT NOT NULL, stay_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_type_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS folio_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT, business_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, reverses_entry_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS housekeeping_tasks (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, assignee TEXT, notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, topic TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, property_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS role_assignments (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cashier_sessions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, opening_amount REAL NOT NULL, expected_amount REAL, counted_amount REAL, variance REAL, opened_at TEXT NOT NULL, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS night_audits (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, blockers_json TEXT NOT NULL, summary_json TEXT, started_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS reservation_transitions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_mutations (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, expected_version INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inventory_controls (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, sell_limit INTEGER, closed INTEGER NOT NULL DEFAULT 0, min_stay INTEGER NOT NULL DEFAULT 1, close_to_arrival INTEGER NOT NULL DEFAULT 0, close_to_departure INTEGER NOT NULL DEFAULT 0, price_override REAL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS room_moves (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, from_room_id TEXT, to_room_id TEXT NOT NULL, move_date TEXT NOT NULL, reason TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account_profiles (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, external_id TEXT, email TEXT, phone TEXT, negotiated_rate_code TEXT, credit_status TEXT NOT NULL DEFAULT 'CASH', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_blocks (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, account_profile_id TEXT, group_profile_id TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, status TEXT NOT NULL, reservation_method TEXT NOT NULL, deduct_inventory INTEGER NOT NULL DEFAULT 1, cutoff_date TEXT, currency TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, cutoff_processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS block_inventory (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, block_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, original_rooms INTEGER NOT NULL, current_rooms INTEGER NOT NULL, picked_up INTEGER NOT NULL DEFAULT 0, rate REAL NOT NULL, cutoff_date TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooming_list_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, block_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, room_type_id TEXT NOT NULL, status TEXT NOT NULL, reservation_id TEXT, rate REAL NOT NULL, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS block_pickup_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, block_id TEXT NOT NULL, rooming_entry_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_number_uq ON rooms(property_id, number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS confirmation_uq ON reservations(property_id, confirmation_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_night_uq ON reservation_nights(property_id, room_id, stay_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_type_night_uq ON reservation_type_nights(reservation_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS type_night_inventory_idx ON reservation_type_nights(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS arrival_idx ON reservations(property_id, arrival_date, status)`,
  `CREATE INDEX IF NOT EXISTS hk_board_idx ON housekeeping_tasks(property_id, business_date, status)`,
  `CREATE INDEX IF NOT EXISTS folio_reservation_idx ON folio_entries(reservation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS role_property_email_uq ON role_assignments(property_id, email)`,
  `CREATE INDEX IF NOT EXISTS cashier_open_idx ON cashier_sessions(property_id, status, actor)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cashier_actor_open_uq ON cashier_sessions(property_id, actor) WHERE status='OPEN'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS night_audit_property_date_uq ON night_audits(property_id, business_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_transition_from_uq ON reservation_transitions(property_id, reservation_id, from_status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_mutation_version_uq ON reservation_mutations(property_id, reservation_id, expected_version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_control_type_date_uq ON inventory_controls(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS inventory_control_calendar_idx ON inventory_controls(property_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS room_move_reservation_idx ON room_moves(property_id, reservation_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_profile_external_uq ON account_profiles(property_id, type, external_id)`,
  `CREATE INDEX IF NOT EXISTS account_profile_search_idx ON account_profiles(property_id, type, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS business_block_code_uq ON business_blocks(property_id, code)`,
  `CREATE INDEX IF NOT EXISTS business_block_dates_idx ON business_blocks(property_id, arrival_date, departure_date, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS block_inventory_type_date_uq ON block_inventory(block_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS block_inventory_house_idx ON block_inventory(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS rooming_list_block_idx ON rooming_list_entries(block_id, status, last_name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rooming_list_reservation_uq ON rooming_list_entries(reservation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS block_pickup_entry_date_uq ON block_pickup_nights(rooming_entry_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS block_pickup_block_date_idx ON block_pickup_nights(block_id, room_type_id, stay_date)`,
  `CREATE TRIGGER IF NOT EXISTS reservation_type_nights_capacity BEFORE INSERT ON reservation_type_nights BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT closed FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),0)=1 THEN RAISE(ABORT, 'room type closed')
      WHEN (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date) + COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0) >= COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date), (SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out')
    END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS block_inventory_capacity_insert BEFORE INSERT ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`,
  `CREATE TRIGGER IF NOT EXISTS block_inventory_capacity_update BEFORE UPDATE ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bi.id<>OLD.id AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_validate BEFORE INSERT ON block_pickup_nights WHEN NOT EXISTS (SELECT 1 FROM block_inventory WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date AND picked_up<current_rooms) BEGIN SELECT RAISE(ABORT, 'block allocation exhausted'); END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_increment AFTER INSERT ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=picked_up+1,version=version+1,updated_at=NEW.created_at WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date; END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_decrement AFTER DELETE ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=MAX(0,picked_up-1),version=version+1,updated_at=datetime('now') WHERE block_id=OLD.block_id AND room_type_id=OLD.room_type_id AND stay_date=OLD.stay_date; END`,
  `CREATE TRIGGER IF NOT EXISTS inventory_controls_validate_insert BEFORE INSERT ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END`,
  `CREATE TRIGGER IF NOT EXISTS inventory_controls_validate_update BEFORE UPDATE ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_validate_insert BEFORE INSERT ON folio_entries WHEN NEW.amount <= 0 OR NEW.kind NOT IN ('CHARGE','PAYMENT') BEGIN SELECT RAISE(ABORT, 'invalid folio entry'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_update BEFORE UPDATE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_delete BEFORE DELETE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
];

async function ready(db: D1) {
  if (!initialization) initialization = initialize(db).catch(error => { initialization = null; throw error; });
  await initialization;
}

async function initialize(db: D1) {
  let propertyExists = false;
  try { propertyExists = Boolean(await db.prepare("SELECT id FROM properties WHERE id='prop-seoul' LIMIT 1").first()); await db.prepare("SELECT id FROM reservation_type_nights LIMIT 1").first(); await db.prepare("SELECT id FROM business_blocks LIMIT 1").first(); }
  catch { await db.batch(schema.map((sql) => db.prepare(sql))); }
  const now = new Date().toISOString();
  await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', 'frontdesk@aurora.hotel', 'PROPERTY_ADMIN', 1, ?)").bind("role-local-admin", now).run();
  if (propertyExists) { await ensureInventoryTriggers(db,now); await ensureGroupTriggers(db,now); await backfillLegacyNights(db,now); return; }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO properties VALUES (?, ?, ?, ?, ?, ?)").bind("prop-seoul", "오로라 서울 호텔", "SEL01", "Asia/Seoul", "KRW", "2026-07-15"),
    db.prepare("INSERT OR IGNORE INTO room_types VALUES (?, ?, ?, ?, ?, ?)").bind("rt-dlx", "prop-seoul", "DLX", "디럭스 킹", 198000, 2),
    db.prepare("INSERT OR IGNORE INTO room_types VALUES (?, ?, ?, ?, ?, ?)").bind("rt-twn", "prop-seoul", "TWN", "프리미어 트윈", 228000, 3),
    db.prepare("INSERT OR IGNORE INTO room_types VALUES (?, ?, ?, ?, ?, ?)").bind("rt-ste", "prop-seoul", "STE", "시티 스위트", 420000, 4),
  ]);
  const rooms = [["101","rt-dlx","CLEAN"],["102","rt-dlx","DIRTY"],["103","rt-twn","INSPECTED"],["201","rt-dlx","CLEAN"],["202","rt-twn","CLEAN"],["203","rt-twn","DIRTY"],["301","rt-ste","INSPECTED"],["302","rt-ste","OUT_OF_SERVICE"]];
  await db.batch(rooms.map(([n,t,h], i) => db.prepare("INSERT OR IGNORE INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(`room-${n}`, "prop-seoul", t, n, Number(n[0]), i === 3 ? "OCCUPIED" : "VACANT", h, JSON.stringify(i > 5 ? ["한강 전망","고층"] : ["금연"]))));
  const guests = [["g1","민준","김","GOLD"],["g2","Sofia","Martinez","NONE"],["g3","서연","박","PLATINUM"],["g4","David","Chen","SILVER"]];
  await db.batch(guests.map(([id,first,last,vip]) => db.prepare("INSERT OR IGNORE INTO guests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id,"prop-seoul",first,last,`${id}@example.com`,`010-20${id.charCodeAt(1)}-8800`,vip,"KR",JSON.stringify(vip !== "NONE" ? ["고층","조용한 객실"] : []),now)));
  const rs = [
    ["r1","SEL-260715-0184","g1","rt-dlx","room-101","DUE_IN",2,0,"Direct","BAR","14:00"],
    ["r2","SEL-260715-0191","g2","rt-twn","room-103","DUE_IN",2,1,"Booking.com","OTA","15:30"],
    ["r3","SEL-260714-0168","g3","rt-dlx","room-201","IN_HOUSE",1,0,"Corporate","CORP",""],
    ["r4","SEL-260715-0202","g4","rt-ste",null,"DUE_IN",2,0,"Expedia","OTA","17:00"],
  ];
  await db.batch(rs.map((r) => db.prepare("INSERT OR IGNORE INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(r[0],r[1],"prop-seoul",r[2],r[3],r[4],r[0]==="r3"?"2026-07-14":"2026-07-15",r[0]==="r3"?"2026-07-17":"2026-07-16",r[5],r[6],r[7],r[8],r[9],r[3]==="rt-ste"?420000:r[3]==="rt-twn"?228000:198000,r[10],r[0]==="r4"?"Late arrival · airport transfer":"",now,now)));
  const nightStatements: D1PreparedStatement[] = [];
  for (const r of rs) {
    const arrival = r[0] === "r3" ? "2026-07-14" : "2026-07-15"; const departure = r[0] === "r3" ? "2026-07-17" : "2026-07-16";
    for (const stayDate of datesBetween(arrival, departure)) {
      nightStatements.push(db.prepare("INSERT OR IGNORE INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(String(r[0]),String(r[3]),stayDate));
      if (r[4]) nightStatements.push(db.prepare("INSERT OR IGNORE INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(String(r[0]),String(r[4]),stayDate));
    }
  }
  if (nightStatements.length) await db.batch(nightStatements);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:group-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now),
  ]);
  await db.batch([
    db.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("fe1","prop-seoul","r3","CHARGE","ROOM","객실료",198000,null,"2026-07-14",now,"night-audit",null),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk102","prop-seoul","room-102","2026-07-15","IN_PROGRESS",1,"이지은","우선 정비",now),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk203","prop-seoul","room-203","2026-07-15","PENDING",2,null,"",now),
  ]);
}

async function ensureInventoryTriggers(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:inventory-triggers-v1'").first(); if(marker) return;
  const triggerSql=schema.filter(sql=>sql.includes("reservation_type_nights_capacity")||sql.includes("inventory_controls_validate_"));
  await db.batch([...triggerSql.map(sql=>db.prepare(sql)),db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now)]);
}

async function ensureGroupTriggers(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:group-triggers-v1'").first(); if(marker) return;
  const capacitySql=schema.find(sql=>sql.includes("reservation_type_nights_capacity")); const groupSql=schema.filter(sql=>sql.includes("block_inventory_capacity_")||sql.includes("block_pickup_"));
  if(!capacitySql) throw new Error("inventory capacity trigger is unavailable");
  await db.batch([db.prepare("DROP TRIGGER IF EXISTS reservation_type_nights_capacity"),db.prepare(capacitySql),...groupSql.map(sql=>db.prepare(sql)),db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:group-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now)]);
}

async function backfillLegacyNights(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:inventory-night-backfill-v1'").first(); if(marker) return;
  await db.batch([
    db.prepare(`WITH RECURSIVE type_dates(property_id,reservation_id,room_type_id,stay_date,departure_date) AS (
      SELECT property_id,id,room_type_id,arrival_date,departure_date FROM reservations WHERE status NOT IN ('CANCELLED','NO_SHOW')
      UNION ALL SELECT property_id,reservation_id,room_type_id,date(stay_date,'+1 day'),departure_date FROM type_dates WHERE date(stay_date,'+1 day') < departure_date
    ) INSERT OR IGNORE INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) SELECT property_id,reservation_id,room_type_id,stay_date FROM type_dates WHERE stay_date < departure_date`),
    db.prepare(`WITH RECURSIVE room_dates(property_id,reservation_id,room_id,stay_date,departure_date) AS (
      SELECT property_id,id,room_id,arrival_date,departure_date FROM reservations WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      UNION ALL SELECT property_id,reservation_id,room_id,date(stay_date,'+1 day'),departure_date FROM room_dates WHERE date(stay_date,'+1 day') < departure_date
    ) INSERT OR IGNORE INTO reservation_nights(property_id,reservation_id,room_id,stay_date) SELECT property_id,reservation_id,room_id,stay_date FROM room_dates WHERE stay_date < departure_date`),
    db.prepare("INSERT INTO idempotency_keys VALUES ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',?)").bind(now),
  ]);
}

function decodedDisplayName(request: Request, email: string) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded || request.headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return email;
  try { return decodeURIComponent(encoded); } catch { return email; }
}

async function principalFor(request: Request, db: D1): Promise<Principal | null> {
  const url = new URL(request.url); let email = request.headers.get("oai-authenticated-user-email");
  if (!email && ["localhost", "127.0.0.1"].includes(url.hostname)) email = "frontdesk@aurora.hotel";
  if (!email) return null;
  let assignment = await db.prepare("SELECT role FROM role_assignments WHERE property_id='prop-seoul' AND email=? AND active=1").bind(email).first<{role: Role}>();
  if (!assignment && request.headers.get("oai-authenticated-user-email")) {
    const configured = await db.prepare("SELECT COUNT(*) count FROM role_assignments WHERE property_id='prop-seoul' AND active=1 AND email<>'frontdesk@aurora.hotel'").first<{count:number}>();
    const bootstrapRole: Role = Number(configured?.count ?? 0) === 0 ? "PROPERTY_ADMIN" : "VIEWER";
    await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', ?, ?, 1, ?)").bind(crypto.randomUUID(), email, bootstrapRole, new Date().toISOString()).run();
    assignment = { role: bootstrapRole };
  }
  const role: Role = (assignment?.role as Role | undefined) ?? "VIEWER";
  return { email, displayName: decodedDisplayName(request, email), role, capabilities: roleCapabilities[role] };
}

async function operationalControls(db: D1, businessDate: string, actor?: string) {
  const [arrivals, cashiers, oos, failed, openCashier, priorAudit, roomPostings] = await Promise.all([
    db.prepare("SELECT COUNT(*) count FROM reservations WHERE property_id='prop-seoul' AND arrival_date=? AND status='DUE_IN'").bind(businessDate).first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=? AND status='OPEN'").bind(businessDate).first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id='prop-seoul' AND housekeeping_status='OUT_OF_SERVICE'").first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'").first<{count:number}>(),
    actor ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first() : null,
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=? LIMIT 1").bind(businessDate).first(),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate).first<{count:number}>(),
  ]);
  const blockers = [
    { code:"UNRESOLVED_ARRIVALS", label:"미처리 도착 예약", count:Number(arrivals?.count??0), blocking:true },
    { code:"OPEN_CASHIERS", label:"미마감 캐셔", count:Number(cashiers?.count??0), blocking:true },
    { code:"FAILED_INTERFACES", label:"인터페이스 전송 실패", count:Number(failed?.count??0), blocking:false },
    { code:"OUT_OF_SERVICE", label:"판매 중지 객실", count:Number(oos?.count??0), blocking:false },
  ];
  return { blockers, canClose: blockers.every(x=>!x.blocking||x.count===0) && !priorAudit, openCashier, priorAudit, pendingRoomPostings:Number(roomPostings?.count??0) };
}

function datesBetween(arrival: string, departure: string) {
  const start = new Date(`${arrival}T00:00:00Z`), end = new Date(`${departure}T00:00:00Z`); const dates: string[] = [];
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) return dates;
  for (let day = new Date(start); day < end && dates.length < 730; day.setUTCDate(day.getUTCDate()+1)) dates.push(day.toISOString().slice(0,10));
  return dates;
}

async function stayControlError(db:D1, roomTypeId:string, arrival:string, departure:string) {
  const nights=datesBetween(arrival,departure); if (!nights.length) return "올바른 숙박 일정을 입력하세요.";
  const controls=await db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date BETWEEN ? AND ?").bind(roomTypeId,arrival,departure).all<Record<string,unknown>>();
  const arrivalControl=controls.results.find(row=>row.stay_date===arrival), departureControl=controls.results.find(row=>row.stay_date===departure);
  if (arrivalControl?.close_to_arrival) return "선택한 도착일은 체크인 제한(CTA)이 설정되어 있습니다.";
  if (departureControl?.close_to_departure) return "선택한 출발일은 체크아웃 제한(CTD)이 설정되어 있습니다.";
  const minimum=Math.max(1,...controls.results.filter(row=>nights.includes(String(row.stay_date))).map(row=>Number(row.min_stay??1)));
  if (nights.length<minimum) return `최소 ${minimum}박 이상 예약해야 합니다.`;
  return null;
}

async function snapshot(db: D1, principal?: Principal | null) {
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult,accountProfilesResult,blocksResult,blockInventoryResult,roomingResult] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN f.amount WHEN f.kind='PAYMENT' THEN -f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id='prop-seoul' GROUP BY r.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') WHERE rm.property_id='prop-seoul' ORDER BY rm.number`),
    principal ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email) : db.prepare("SELECT * FROM cashier_sessions WHERE 0"),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id='prop-seoul') AND r.departure_date>(SELECT business_date FROM properties WHERE id='prop-seoul') AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND f.kind='CHARGE' AND f.code='ROOM')"),
    db.prepare("SELECT * FROM room_types WHERE property_id='prop-seoul' ORDER BY code"),
    db.prepare("SELECT room_type_id, stay_date, COUNT(*) booked FROM reservation_type_nights WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day') GROUP BY room_type_id, stay_date"),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day')"),
    db.prepare("SELECT * FROM account_profiles WHERE property_id='prop-seoul' AND active=1 ORDER BY type,name"),
    db.prepare("SELECT bb.*,ap.name account_name,gp.name group_name,COALESCE(SUM(bi.original_rooms),0) original_room_nights,COALESCE(SUM(bi.current_rooms),0) current_room_nights,COALESCE(SUM(bi.picked_up),0) picked_up_room_nights FROM business_blocks bb LEFT JOIN account_profiles ap ON ap.id=bb.account_profile_id LEFT JOIN account_profiles gp ON gp.id=bb.group_profile_id LEFT JOIN block_inventory bi ON bi.block_id=bb.id WHERE bb.property_id='prop-seoul' GROUP BY bb.id ORDER BY bb.arrival_date,bb.code"),
    db.prepare("SELECT bi.*,rt.code room_type_code,rt.name room_type_name FROM block_inventory bi JOIN room_types rt ON rt.id=bi.room_type_id WHERE bi.property_id='prop-seoul' ORDER BY bi.block_id,bi.stay_date,rt.code"),
    db.prepare("SELECT rl.*,rt.code room_type_code,rt.name room_type_name FROM rooming_list_entries rl JOIN room_types rt ON rt.id=rl.room_type_id WHERE rl.property_id='prop-seoul' ORDER BY rl.block_id,rl.last_name,rl.first_name"),
  ]);
  const property = propertyResult.results[0] as Record<string,unknown>; const reservations=reservationResult.results as Array<Record<string,unknown>>; const rooms=roomResult.results as Array<Record<string,unknown>>;
  const metrics = { rooms:rooms.length, occupied:rooms.filter(x=>x.front_desk_status==='OCCUPIED').length, dirty:rooms.filter(x=>x.housekeeping_status==='DIRTY').length, ready:rooms.filter(x=>x.housekeeping_status==='CLEAN'||x.housekeeping_status==='INSPECTED').length };
  const arrivals=reservations.filter(x=>x.arrival_date===property.business_date&&x.status==='DUE_IN').length, cashiers=Number((openCashierResult.results[0] as {count?:number})?.count??0), failed=Number((failedResult.results[0] as {count?:number})?.count??0), oos=rooms.filter(x=>x.housekeeping_status==='OUT_OF_SERVICE').length;
  const blockers = [
    { code:"UNRESOLVED_ARRIVALS", label:"미처리 도착 예약", count:arrivals, blocking:true },
    { code:"OPEN_CASHIERS", label:"미마감 캐셔", count:cashiers, blocking:true },
    { code:"FAILED_INTERFACES", label:"인터페이스 전송 실패", count:failed, blocking:false },
    { code:"OUT_OF_SERVICE", label:"판매 중지 객실", count:oos, blocking:false },
  ];
  const priorAudit=auditResult.results[0]??null; const controls={blockers,canClose:blockers.every(x=>!x.blocking||x.count===0)&&!priorAudit,openCashier:actorCashierResult.results[0]??null,priorAudit,pendingRoomPostings:Number((postingsResult.results[0] as {count?:number})?.count??0)};
  const dates=Array.from({length:14},(_,index)=>{const day=new Date(`${String(property.business_date)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+index);return day.toISOString().slice(0,10)});
  const typeNights=typeNightsResult.results as Array<Record<string,unknown>>, controlRows=inventoryControlsResult.results as Array<Record<string,unknown>>, roomTypes=roomTypesResult.results as Array<Record<string,unknown>>;
  const booked=new Map(typeNights.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.booked)])); const inventoryControls=new Map(controlRows.map(row=>[`${row.room_type_id}:${row.stay_date}`,row]));
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`);const sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
  const groups={accounts:accountProfilesResult.results,blocks:blocksResult.results,inventory:blockInventoryResult.results,rooming:roomingResult.results};
  return { property, reservations, rooms, metrics, principal, controls, inventory, groups };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const snapshotCache = new Map<string,{expires:number,value:Promise<Snapshot>}>();
function invalidateSnapshots() { snapshotCache.clear(); }
async function cachedSnapshot(db:D1, principal:Principal) {
  const key=principal.email; const cached=snapshotCache.get(key); const now=Date.now();
  if (cached && cached.expires>now) return cached.value;
  const value=snapshot(db,principal); snapshotCache.set(key,{expires:now+3000,value});
  try { return await value; } catch (error) { snapshotCache.delete(key); throw error; }
}

export async function GET(request: Request) {
  await ready(env.DB); const principal = await principalFor(request, env.DB);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  return Response.json(await cachedSnapshot(env.DB, principal), { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  await ready(env.DB); const principal = await principalFor(request, env.DB);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  let body: Record<string, string>;
  try { body = await request.json() as Record<string, string>; }
  catch { return Response.json({error:"요청 본문이 올바른 JSON이 아닙니다."},{status:400}); }
  const now = new Date().toISOString(); const actor = principal.email;
  const requiredCapability = actionCapability[body.action];
  if (!requiredCapability || !principal.capabilities.includes(requiredCapability)) return Response.json({error:"이 작업을 수행할 권한이 없습니다."},{status:403});
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    const duplicate = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key=?").bind(idempotencyKey).first();
    if (duplicate) return Response.json(await cachedSnapshot(env.DB, principal), {headers:{"X-Idempotent-Replay":"true"}});
  }
  const reservation = body.reservationId ? await env.DB.prepare("SELECT * FROM reservations WHERE id=?").bind(body.reservationId).first<Record<string, unknown>>() : null;
  const propertyState = await env.DB.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(propertyState?.business_date);
  try {
    if (body.action === "create_reservation") {
      const arrival = new Date(`${body.arrivalDate}T00:00:00Z`), departure = new Date(`${body.departureDate}T00:00:00Z`);
      if (!body.firstName?.trim() || !body.lastName?.trim() || !Number.isFinite(arrival.valueOf()) || departure <= arrival) return Response.json({error:"고객명과 올바른 숙박 일정을 입력하세요."},{status:400});
      const type = await env.DB.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>();
      if (!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const controlError=await stayControlError(env.DB,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const room = body.roomId ? await env.DB.prepare("SELECT * FROM rooms WHERE id=? AND room_type_id=?").bind(body.roomId,body.roomTypeId).first<Record<string,unknown>>() : null;
      if (body.roomId && !room) return Response.json({error:"선택한 객실과 객실 타입이 일치하지 않습니다."},{status:409});
      const guestId=crypto.randomUUID(), reservationId=crypto.randomUUID(), confirmation=`SEL-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`;
      const statements = [
        env.DB.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', ?, '[]', ?)").bind(guestId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.nationality||"KR",now),
        env.DB.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, ?, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, ?, '', 1, ?, ?)").bind(reservationId,confirmation,guestId,body.roomTypeId,body.roomId||null,body.arrivalDate,body.departureDate,Number(body.adults)||1,Number(body.children)||0,body.source||"Direct",body.ratePlan||"BAR",Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,now,now),
      ];
      for (const stayDate of datesBetween(body.arrivalDate,body.departureDate)) {
        statements.push(env.DB.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomTypeId,stayDate));
        if (body.roomId) statements.push(env.DB.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomId,stayDate));
      }
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_RESERVATION', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,reservationId,JSON.stringify({confirmation,status:"DUE_IN"}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),reservationId,JSON.stringify({reservationId,confirmation}),now));
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "edit_reservation" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 수정할 수 있습니다."},{status:409});
      if(await env.DB.prepare("SELECT id FROM rooming_list_entries WHERE reservation_id=?").bind(body.reservationId).first()) return Response.json({error:"그룹 픽업 예약은 블록 rooming list에서 수정하세요."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const type=await env.DB.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!stayDates.length) return Response.json({error:"올바른 숙박 일정을 입력하세요."},{status:400});
      const controlError=await stayControlError(env.DB,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const retainedRoom=reservation.room_id && reservation.room_type_id===body.roomTypeId ? String(reservation.room_id) : null;
      const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'EDIT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        env.DB.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("UPDATE reservations SET room_type_id=?, room_id=?, arrival_date=?, departure_date=?, adults=?, children=?, rate_plan=?, nightly_rate=?, eta=?, notes=?, version=version+1, updated_at=? WHERE id=? AND status='DUE_IN' AND version=?").bind(body.roomTypeId,retainedRoom,body.arrivalDate,body.departureDate,Math.max(1,Number(body.adults)||1),Math.max(0,Number(body.children)||0),body.ratePlan||String(reservation.rate_plan),Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,body.notes||"",now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of stayDates){
        statements.push(env.DB.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomTypeId,stayDate));
        if(retainedRoom) statements.push(env.DB.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,retainedRoom,stayDate));
      }
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'EDIT_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({roomTypeId:body.roomTypeId,arrivalDate:body.arrivalDate,departureDate:body.departureDate,roomId:retainedRoom}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.updated', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,version:expectedVersion+1}),now));
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "assign_room" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약에만 객실을 배정할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const room=await env.DB.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.room_type_id!==reservation.room_type_id) return Response.json({error:"예약 객실 타입과 배정 객실 타입이 일치하지 않습니다."},{status:409});
      if(room.housekeeping_status==="OUT_OF_SERVICE") return Response.json({error:"판매 중지 객실은 배정할 수 없습니다."},{status:409});
      const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'ASSIGN_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND status='DUE_IN' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of datesBetween(String(reservation.arrival_date),String(reservation.departure_date))) statements.push(env.DB.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ASSIGN_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.room_assigned', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:body.roomId}),now));
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "move_room" && reservation) {
      if(reservation.status!=="IN_HOUSE"||!reservation.room_id) return Response.json({error:"투숙 중이고 객실이 배정된 예약만 룸 무브할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"룸 무브 사유를 입력하세요."},{status:400});
      if(body.roomId===reservation.room_id) return Response.json({error:"현재 객실과 다른 객실을 선택하세요."},{status:400});
      const room=await env.DB.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.front_desk_status!=="VACANT"||!["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"공실이며 청소 또는 점검이 완료된 객실만 이동할 수 있습니다."},{status:409});
      const futureDates=datesBetween(businessDate,String(reservation.departure_date)); if(!futureDates.length) return Response.json({error:"남은 숙박일이 없습니다."},{status:409});
      const moveId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'MOVE_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        env.DB.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
        env.DB.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=?").bind(String(reservation.room_id)),
        env.DB.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND front_desk_status='VACANT'").bind(body.roomId),
        env.DB.prepare("INSERT INTO room_moves VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?)").bind(moveId,body.reservationId,String(reservation.room_id),body.roomId,businessDate,body.reason.trim(),body.notes||"",actor,now),
      ];
      for(const stayDate of futureDates) statements.push(env.DB.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(env.DB.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 1, NULL, '룸 무브 출발 객실', ?)").bind(crypto.randomUUID(),String(reservation.room_id),businessDate,now));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MOVE_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId,reason:body.reason}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.room_moved', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,fromRoomId:reservation.room_id,toRoomId:body.roomId,reason:body.reason}),now));
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "cancel_reservation" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약만 취소할 수 있습니다."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"예약 취소 사유를 입력하세요."},{status:400});
      const groupEntry=await env.DB.prepare("SELECT * FROM rooming_list_entries WHERE reservation_id=?").bind(body.reservationId).first<Record<string,unknown>>();
      const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'CANCELLED', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        env.DB.prepare("UPDATE reservations SET status='CANCELLED', version=version+1, notes=notes || ?, updated_at=? WHERE id=? AND status='DUE_IN'").bind(`\n[취소] ${body.reason.trim()}`,now,body.reservationId),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CANCEL_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CANCELLED",reason:body.reason.trim()}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.cancelled', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,reason:body.reason.trim()}),now),
      ];
      if(groupEntry){statements.push(env.DB.prepare("DELETE FROM block_pickup_nights WHERE rooming_entry_id=?").bind(String(groupEntry.id)));statements.push(env.DB.prepare("UPDATE rooming_list_entries SET status='CANCELLED',version=version+1,updated_at=? WHERE id=?").bind(now,String(groupEntry.id)));}
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "update_inventory_control") {
      const stayDate=String(body.stayDate), roomType=await env.DB.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!roomType) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const horizon=new Date(`${businessDate}T00:00:00Z`);horizon.setUTCDate(horizon.getUTCDate()+365); if(stayDate<businessDate||stayDate>horizon.toISOString().slice(0,10)) return Response.json({error:"영업일부터 365일 범위만 수정할 수 있습니다."},{status:400});
      const capacity=await env.DB.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id='prop-seoul' AND room_type_id=? AND housekeeping_status<>'OUT_OF_SERVICE'").bind(body.roomTypeId).first<{count:number}>(); const physical=Number(capacity?.count??0);
      const sellLimit=body.sellLimit===""?physical:Number(body.sellLimit), minStay=Number(body.minStay||1), price=body.priceOverride===""?null:Number(body.priceOverride), closed=body.closed==="true"?1:0;
      if(!Number.isInteger(sellLimit)||sellLimit<0||sellLimit>physical||!Number.isInteger(minStay)||minStay<1||minStay>30||price!==null&&(!Number.isFinite(price)||price<0)) return Response.json({error:"판매 수량·최소 숙박·요금을 올바르게 입력하세요."},{status:400});
      const reserved=await env.DB.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first<{count:number}>(); if(!closed&&sellLimit<Number(reserved?.count??0)) return Response.json({error:"이미 확정된 예약 수보다 판매 한도를 낮출 수 없습니다."},{status:409});
      const existing=await env.DB.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first(); const controlId=String((existing as Record<string,unknown>|null)?.id??crypto.randomUUID());
      const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO inventory_controls VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(property_id,room_type_id,stay_date) DO UPDATE SET sell_limit=excluded.sell_limit,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,price_override=excluded.price_override,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(controlId,body.roomTypeId,stayDate,sellLimit,closed,minStay,body.cta==="true"?1:0,body.ctd==="true"?1:0,price,now,actor),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_INVENTORY_CONTROL', 'inventory_control', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,controlId,existing?JSON.stringify(existing):null,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,cta:body.cta==="true",ctd:body.ctd==="true",price}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'inventory.updated', 'room_type', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.roomTypeId,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,price}),now),
      ];
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "create_account_profile") {
      const type=String(body.type),name=body.name?.trim(); if(!["COMPANY","TRAVEL_AGENT","SOURCE","GROUP"].includes(type)||!name) return Response.json({error:"프로필 유형과 이름을 올바르게 입력하세요."},{status:400});
      const profileId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO account_profiles VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)").bind(profileId,type,name,body.externalId?.trim()||null,body.email?.trim()||null,body.phone?.trim()||null,body.negotiatedRateCode?.trim()||null,body.creditStatus||"CASH",body.notes||"",now,now),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ACCOUNT_PROFILE', 'account_profile', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,profileId,JSON.stringify({type,name,externalId:body.externalId||null}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'profile.created', 'account_profile', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),profileId,JSON.stringify({profileId,type,name}),now),
      ];
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await env.DB.batch(statements);
    } else if (body.action === "create_business_block") {
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.name?.trim()||!stayDates.length) return Response.json({error:"블록 이름과 올바른 일정을 입력하세요."},{status:400});
      let allocations:Array<{roomTypeId:string;rooms:number;rate:number}>; try{allocations=JSON.parse(body.allocations||"[]") as Array<{roomTypeId:string;rooms:number;rate:number}>}catch{return Response.json({error:"객실 할당 정보가 올바르지 않습니다."},{status:400})}
      allocations=allocations.filter(item=>item.roomTypeId&&Number.isInteger(Number(item.rooms))&&Number(item.rooms)>0&&Number(item.rate)>=0).map(item=>({...item,rooms:Number(item.rooms),rate:Number(item.rate)})); if(!allocations.length) return Response.json({error:"한 개 이상의 객실 타입 할당을 입력하세요."},{status:400});
      const types=await env.DB.prepare("SELECT id FROM room_types WHERE property_id='prop-seoul'").all<{id:string}>(); const validTypes=new Set(types.results.map(type=>type.id)); if(allocations.some(item=>!validTypes.has(item.roomTypeId))) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const accountId=body.accountProfileId||null,groupId=body.groupProfileId||null; if(accountId&&!await env.DB.prepare("SELECT id FROM account_profiles WHERE id=? AND type IN ('COMPANY','TRAVEL_AGENT','SOURCE') AND active=1").bind(accountId).first()) return Response.json({error:"유효한 회사·여행사·소스 프로필을 선택하세요."},{status:400}); if(groupId&&!await env.DB.prepare("SELECT id FROM account_profiles WHERE id=? AND type='GROUP' AND active=1").bind(groupId).first()) return Response.json({error:"유효한 그룹 프로필을 선택하세요."},{status:400});
      const blockId=crypto.randomUUID(),code=body.code?.trim()||`BLK-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,status=["TENTATIVE","DEFINITE"].includes(body.status)?body.status:"TENTATIVE",cutoffDate=body.cutoffDate||body.arrivalDate,deduct=body.deductInventory==="false"?0:1;
      const statements:D1PreparedStatement[]=[env.DB.prepare("INSERT INTO business_blocks VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 1, NULL, ?, ?)").bind(blockId,code,body.name.trim(),accountId,groupId,body.arrivalDate,body.departureDate,status,body.reservationMethod||"ROOMING_LIST",deduct,cutoffDate,body.notes||"",now,now)];
      for(const allocation of allocations) for(const stayDate of stayDates) statements.push(env.DB.prepare("INSERT INTO block_inventory VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)").bind(crypto.randomUUID(),blockId,allocation.roomTypeId,stayDate,allocation.rooms,allocation.rooms,allocation.rate,cutoffDate,now));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_BUSINESS_BLOCK', 'business_block', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,blockId,JSON.stringify({code,name:body.name,status,arrivalDate:body.arrivalDate,departureDate:body.departureDate,allocations}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.created', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),blockId,JSON.stringify({blockId,code,status}),now));
      if(idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await env.DB.batch(statements);
    } else if (body.action === "update_block_inventory") {
      const row=await env.DB.prepare("SELECT bi.*,bb.status block_status FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.block_id=? AND bi.room_type_id=? AND bi.stay_date=?").bind(body.blockId,body.roomTypeId,body.stayDate).first<Record<string,unknown>>(); if(!row||!["TENTATIVE","DEFINITE"].includes(String(row.block_status))) return Response.json({error:"수정 가능한 블록 재고를 찾지 못했습니다."},{status:409});
      const rooms=Number(body.rooms),rate=Number(body.rate); if(!Number.isInteger(rooms)||rooms<Number(row.picked_up)||!Number.isFinite(rate)||rate<0) return Response.json({error:"픽업 수보다 낮지 않은 객실 수와 올바른 요금을 입력하세요."},{status:400});
      const statements:D1PreparedStatement[]=[env.DB.prepare("UPDATE block_inventory SET current_rooms=?,rate=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(rooms,rate,now,row.id,Number(row.version)),env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_BLOCK_INVENTORY', 'block_inventory', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(row.id),JSON.stringify(row),JSON.stringify({currentRooms:rooms,rate}),now),env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.inventory_updated', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId,roomTypeId:body.roomTypeId,stayDate:body.stayDate,rooms,rate}),now)]; if(idempotencyKey)statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await env.DB.batch(statements);
    } else if (body.action === "add_rooming_entry") {
      const block=await env.DB.prepare("SELECT * FROM business_blocks WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block) return Response.json({error:"픽업 가능한 블록을 찾지 못했습니다."},{status:409});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.firstName?.trim()||!body.lastName?.trim()||!stayDates.length||body.arrivalDate<String(block.arrival_date)||body.departureDate>String(block.departure_date)) return Response.json({error:"고객명과 블록 범위 안의 일정을 입력하세요."},{status:400});
      const grid=await env.DB.prepare("SELECT * FROM block_inventory WHERE block_id=? AND room_type_id=? AND stay_date>=? AND stay_date<? ORDER BY stay_date").bind(body.blockId,body.roomTypeId,body.arrivalDate,body.departureDate).all<Record<string,unknown>>(); if(grid.results.length!==stayDates.length) return Response.json({error:"선택한 객실 타입의 블록 할당이 일정 전체에 없습니다."},{status:409});
      const entryId=crypto.randomUUID(),rate=Number(body.rate)||Number(grid.results[0]?.rate??0); const statements:D1PreparedStatement[]=[env.DB.prepare("INSERT INTO rooming_list_entries VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, 1, ?, ?)").bind(entryId,body.blockId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.arrivalDate,body.departureDate,body.roomTypeId,rate,body.notes||"",now,now),env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ADD_ROOMING_ENTRY', 'rooming_list_entry', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,entryId,JSON.stringify({blockId:body.blockId,firstName:body.firstName,lastName:body.lastName,roomTypeId:body.roomTypeId}),now)]; if(idempotencyKey)statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await env.DB.batch(statements);
    } else if (body.action === "pickup_rooming_entry") {
      const entry=await env.DB.prepare("SELECT rl.*,bb.code block_code,bb.status block_status FROM rooming_list_entries rl JOIN business_blocks bb ON bb.id=rl.block_id WHERE rl.id=?").bind(body.entryId).first<Record<string,unknown>>(); if(!entry||entry.status!=="PENDING"||!["TENTATIVE","DEFINITE"].includes(String(entry.block_status))) return Response.json({error:"이미 픽업됐거나 픽업할 수 없는 rooming list 항목입니다."},{status:409});
      const reservationId=crypto.randomUUID(),guestId=crypto.randomUUID(),confirmation=`SEL-${String(entry.arrival_date).replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,stayDates=datesBetween(String(entry.arrival_date),String(entry.departure_date)); const statements:D1PreparedStatement[]=[
        env.DB.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', 'KR', '[]', ?)").bind(guestId,String(entry.first_name),String(entry.last_name),entry.email??null,entry.phone??null,now),
        env.DB.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', 1, 0, 'Group', ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,String(entry.room_type_id),String(entry.arrival_date),String(entry.departure_date),String(entry.block_code),Number(entry.rate),`Block ${entry.block_code} · Rooming list`,now,now),
      ];
      for(const stayDate of stayDates){statements.push(env.DB.prepare("INSERT INTO block_pickup_nights(property_id,block_id,rooming_entry_id,room_type_id,stay_date,created_at) VALUES ('prop-seoul',?,?,?,?,?)").bind(String(entry.block_id),String(entry.id),String(entry.room_type_id),stayDate,now));statements.push(env.DB.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,String(entry.room_type_id),stayDate));}
      statements.push(env.DB.prepare("UPDATE rooming_list_entries SET status='PICKED_UP',reservation_id=?,version=version+1,updated_at=? WHERE id=? AND status='PENDING'").bind(reservationId,now,String(entry.id))); statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'PICKUP_ROOMING_ENTRY', 'rooming_list_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(entry.id),JSON.stringify(entry),JSON.stringify({status:"PICKED_UP",reservationId,confirmation}),now)); statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.reservation_picked_up', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),String(entry.block_id),JSON.stringify({blockId:entry.block_id,entryId:entry.id,reservationId,confirmation}),now)); if(idempotencyKey)statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await env.DB.batch(statements);
    } else if (body.action === "cutoff_block") {
      const block=await env.DB.prepare("SELECT * FROM business_blocks WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block)return Response.json({error:"마감 가능한 블록을 찾지 못했습니다."},{status:409}); const statements:D1PreparedStatement[]=[env.DB.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=?").bind(now,body.blockId),env.DB.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(now,now,body.blockId),env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CUTOFF_BLOCK', 'business_block', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.blockId,JSON.stringify(block),JSON.stringify({status:"CUTOFF"}),now),env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId}),now)];if(idempotencyKey)statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));await env.DB.batch(statements);
    } else if (body.action === "open_cashier") {
      const property = await env.DB.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>();
      const openingAmount = Number(body.openingAmount || 0); if (!Number.isFinite(openingAmount) || openingAmount < 0) return Response.json({error:"시재금은 0원 이상이어야 합니다."},{status:400});
      const existing = await env.DB.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (existing) return Response.json({error:"이미 개시된 캐셔 세션이 있습니다."},{status:409});
      const cashierId = crypto.randomUUID(); const statements = [
        env.DB.prepare("INSERT INTO cashier_sessions VALUES (?, 'prop-seoul', ?, ?, 'OPEN', ?, NULL, NULL, NULL, ?, NULL)").bind(cashierId,actor,property?.business_date,openingAmount,now),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'OPEN_CASHIER', 'cashier_session', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,cashierId,JSON.stringify({openingAmount,businessDate:property?.business_date}),now),
      ];
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "close_cashier") {
      const session = await env.DB.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first<Record<string,unknown>>();
      if (!session) return Response.json({error:"개시된 캐셔 세션이 없습니다."},{status:409});
      const cash = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) total FROM folio_entries WHERE property_id='prop-seoul' AND business_date=? AND created_by=? AND kind='PAYMENT' AND payment_method='CASH'").bind(session.business_date,actor).first<{total:number}>();
      const expected = Number(session.opening_amount)+Number(cash?.total??0), counted=Number(body.countedAmount);
      if (!Number.isFinite(counted) || counted < 0) return Response.json({error:"실사 현금을 올바르게 입력하세요."},{status:400});
      const variance = counted-expected; const statements = [
        env.DB.prepare("UPDATE cashier_sessions SET status='CLOSED', expected_amount=?, counted_amount=?, variance=?, closed_at=? WHERE id=? AND status='OPEN'").bind(expected,counted,variance,now,session.id),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_CASHIER', 'cashier_session', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,session.id,JSON.stringify(session),JSON.stringify({status:"CLOSED",expected,counted,variance}),now),
      ];
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "run_night_audit") {
      const property = await env.DB.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(property?.business_date);
      const controls = await operationalControls(env.DB,businessDate,actor);
      if (!controls.canClose) return Response.json({error:"영업일 마감 선행조건이 충족되지 않았습니다.",blockers:controls.blockers},{status:409});
      const stays = await env.DB.prepare("SELECT r.id, r.room_id, r.nightly_rate FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate).all<{id:string;room_id:string;nightly_rate:number}>();
      const cutoffBlocks=await env.DB.prepare("SELECT id FROM business_blocks WHERE property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE') AND cutoff_date IS NOT NULL AND cutoff_date<=?").bind(businessDate).all<{id:string}>();
      const next = new Date(`${businessDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1); const nextDate=next.toISOString().slice(0,10); const auditId=crypto.randomUUID();
      const statements = [env.DB.prepare("INSERT INTO night_audits VALUES (?, 'prop-seoul', ?, 'COMPLETED', '[]', ?, ?, ?, ?)").bind(auditId,businessDate,JSON.stringify({roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length,nextBusinessDate:nextDate}),now,now,actor)];
      for (const stay of stays.results) {
        statements.push(env.DB.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', 'ROOM', '객실료 자동 전기', ?, NULL, ?, ?, 'night-audit', NULL)").bind(crypto.randomUUID(),stay.id,stay.nightly_rate,businessDate,now));
        if (stay.room_id) statements.push(env.DB.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 2, NULL, '스테이오버 객실', ?)").bind(crypto.randomUUID(),stay.room_id,nextDate,now));
      }
      for(const block of cutoffBlocks.results){statements.push(env.DB.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=?").bind(now,block.id));statements.push(env.DB.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=?").bind(now,now,block.id));statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),block.id,JSON.stringify({blockId:block.id,automatic:true,businessDate}),now));}
      statements.push(env.DB.prepare("UPDATE properties SET business_date=? WHERE id='prop-seoul' AND business_date=?").bind(nextDate,businessDate));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_BUSINESS_DATE', 'night_audit', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,auditId,JSON.stringify({businessDate}),JSON.stringify({nextDate,roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'business_date.closed', 'night_audit', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),auditId,JSON.stringify({businessDate,nextDate}),now));
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "mark_no_show" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 노쇼 처리할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 노쇼 처리할 수 없습니다."},{status:409});
      const statements = [
        env.DB.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'NO_SHOW', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        env.DB.prepare("UPDATE reservations SET status='NO_SHOW', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now,body.reservationId),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MARK_NO_SHOW', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"NO_SHOW"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.no_show', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId}),now),
      ];
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 체크인할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 체크인할 수 없습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"객실 배정이 필요합니다."},{status:409});
      const room = await env.DB.prepare("SELECT * FROM rooms WHERE id=?").bind(reservation.room_id).first<Record<string, unknown>>();
      if (!room || !["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"청소 완료 또는 점검 완료 객실만 체크인할 수 있습니다."},{status:409});
      await env.DB.batch([
        env.DB.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'IN_HOUSE', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        env.DB.prepare("UPDATE reservations SET status='IN_HOUSE', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now, body.reservationId),
        env.DB.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=?").bind(reservation.room_id),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_IN","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"IN_HOUSE"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_in', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "check_out" && reservation) {
      if (reservation.status !== "IN_HOUSE") return Response.json({error:"투숙 중 예약만 체크아웃할 수 있습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"예약에 배정된 객실이 없습니다."},{status:409});
      const bal = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount WHEN kind='PAYMENT' THEN -amount ELSE 0 END),0) balance FROM folio_entries WHERE reservation_id=?").bind(body.reservationId).first<{balance:number}>();
      if (Math.abs(bal?.balance ?? 0) > .01) return Response.json({error:"잔액을 정산한 뒤 체크아웃하세요."},{status:409});
      const task = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'IN_HOUSE', 'CHECKED_OUT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        env.DB.prepare("UPDATE reservations SET status='CHECKED_OUT', departure_date=CASE WHEN departure_date>? THEN ? ELSE departure_date END, version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE'").bind(businessDate,businessDate,now,body.reservationId),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        env.DB.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        env.DB.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=?").bind(reservation.room_id),
        env.DB.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, 'PENDING', 1, NULL, '체크아웃 객실', ?)").bind(task,"prop-seoul",reservation.room_id,businessDate,now),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_OUT","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CHECKED_OUT"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_out', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_payment" && reservation) {
      const amount = Number(body.amount); if (!(amount > 0)) return Response.json({error:"결제 금액이 올바르지 않습니다."},{status:400});
      const cashier = await env.DB.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"결제 전 캐셔 세션을 개시하세요."},{status:409});
      await env.DB.batch([
        env.DB.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, 'PAYMENT', 'PAYMENT', '프런트 결제', ?, ?, ?, ?, ?, NULL)").bind(crypto.randomUUID(),"prop-seoul",body.reservationId,amount,body.method || "CARD",businessDate,now,actor),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.payment_posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,method:body.method||"CARD"}),now),
        ...(idempotencyKey ? [env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_charge" && reservation) {
      const amount=Number(body.amount); if(!(amount>0)) return Response.json({error:"전기 금액이 올바르지 않습니다."},{status:400});
      const cashier = await env.DB.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"비용 전기 전 캐셔 세션을 개시하세요."},{status:409});
      await env.DB.batch([
        env.DB.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,body.code||"MISC",body.description||"기타 매출",amount,businessDate,now,actor),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,kind:"CHARGE"}),now),
        ...(idempotencyKey ? [env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "housekeeping") {
      const status = body.status === "INSPECTED" ? "INSPECTED" : "CLEAN";
      await env.DB.batch([
        env.DB.prepare("UPDATE rooms SET housekeeping_status=?, version=version+1 WHERE id=?").bind(status,body.roomId),
        env.DB.prepare("UPDATE housekeeping_tasks SET status='DONE', updated_at=? WHERE room_id=? AND business_date=?").bind(now,body.roomId,businessDate),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"HOUSEKEEPING_COMPLETE","room",body.roomId,JSON.stringify({housekeepingStatus:status}),now),
        ...(idempotencyKey ? [env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else return Response.json({error:"지원하지 않는 작업입니다."},{status:400});
    invalidateSnapshots();
    return Response.json(await snapshot(env.DB, principal));
  } catch (error) {
    const message=error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    if (message.includes("room_night_uq") || message.includes("reservation_nights.property_id")) return Response.json({error:"선택한 객실은 해당 일정에 이미 예약되어 있습니다. 다른 객실을 선택하세요."},{status:409});
    if (message.includes("reservation_transition_from_uq") || message.includes("reservation_transitions.property_id")) return Response.json({error:"다른 작업자가 이미 이 예약의 상태를 변경했습니다. 화면을 새로고침해 확인하세요."},{status:409});
    if (message.includes("reservation_mutation_version_uq") || message.includes("reservation_mutations.property_id")) return Response.json({error:"다른 작업자가 같은 예약 버전을 먼저 변경했습니다. 화면을 새로고침하세요."},{status:409});
    if (message.includes("room type sold out")) return Response.json({error:"선택한 객실 타입은 해당 날짜에 판매 가능한 재고가 없습니다."},{status:409});
    if (message.includes("room type closed")) return Response.json({error:"선택한 객실 타입은 해당 날짜에 판매가 마감되었습니다."},{status:409});
    if (message.includes("reservation_type_night_uq")) return Response.json({error:"예약의 날짜별 재고가 이미 반영되어 있습니다."},{status:409});
    if (message.includes("block inventory sold out")) return Response.json({error:"블록 할당이 하우스 가용 재고를 초과합니다."},{status:409});
    if (message.includes("block allocation exhausted")) return Response.json({error:"선택한 날짜의 블록 가용 객실이 모두 픽업되었습니다."},{status:409});
    if (message.includes("block_pickup_entry_date_uq") || message.includes("block_pickup_nights.rooming_entry_id")) return Response.json({error:"다른 작업자가 이미 이 rooming list 항목을 픽업했습니다."},{status:409});
    if (message.includes("business_block_code_uq") || message.includes("business_blocks.property_id")) return Response.json({error:"이미 사용 중인 블록 코드입니다."},{status:409});
    if (message.includes("account_profile_external_uq") || message.includes("account_profiles.property_id")) return Response.json({error:"같은 유형과 외부 ID의 프로필이 이미 있습니다."},{status:409});
    return Response.json({error:message},{status:500});
  }
}
