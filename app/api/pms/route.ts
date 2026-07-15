import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";
type D1 = typeof env.DB;
type Role = "PROPERTY_ADMIN" | "NIGHT_AUDITOR" | "FRONT_DESK" | "CASHIER" | "HOUSEKEEPING" | "REVENUE_MANAGER" | "VIEWER";
type Principal = { email: string; displayName: string; role: Role; capabilities: string[] };

const roleCapabilities: Record<Role, string[]> = {
  PROPERTY_ADMIN: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "HOUSEKEEPING_WRITE", "CASHIER_WRITE", "EOD_RUN", "ADMIN"],
  NIGHT_AUDITOR: ["READ", "FOLIO_WRITE", "CASHIER_WRITE", "EOD_RUN"],
  FRONT_DESK: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE"],
  CASHIER: ["READ", "FOLIO_WRITE", "CASHIER_WRITE"],
  HOUSEKEEPING: ["READ", "HOUSEKEEPING_WRITE"],
  REVENUE_MANAGER: ["READ"],
  VIEWER: ["READ"],
};

const actionCapability: Record<string, string> = {
  create_reservation: "RESERVATION_WRITE", mark_no_show: "STAY_WRITE", check_in: "STAY_WRITE", check_out: "STAY_WRITE",
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
  `CREATE TABLE IF NOT EXISTS folio_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT, business_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, reverses_entry_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS housekeeping_tasks (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, assignee TEXT, notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, topic TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, property_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS role_assignments (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cashier_sessions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, opening_amount REAL NOT NULL, expected_amount REAL, counted_amount REAL, variance REAL, opened_at TEXT NOT NULL, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS night_audits (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, blockers_json TEXT NOT NULL, summary_json TEXT, started_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS reservation_transitions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_number_uq ON rooms(property_id, number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS confirmation_uq ON reservations(property_id, confirmation_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_night_uq ON reservation_nights(property_id, room_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS arrival_idx ON reservations(property_id, arrival_date, status)`,
  `CREATE INDEX IF NOT EXISTS hk_board_idx ON housekeeping_tasks(property_id, business_date, status)`,
  `CREATE INDEX IF NOT EXISTS folio_reservation_idx ON folio_entries(reservation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS role_property_email_uq ON role_assignments(property_id, email)`,
  `CREATE INDEX IF NOT EXISTS cashier_open_idx ON cashier_sessions(property_id, status, actor)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cashier_actor_open_uq ON cashier_sessions(property_id, actor) WHERE status='OPEN'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS night_audit_property_date_uq ON night_audits(property_id, business_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_transition_from_uq ON reservation_transitions(property_id, reservation_id, from_status)`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_validate_insert BEFORE INSERT ON folio_entries WHEN NEW.amount <= 0 OR NEW.kind NOT IN ('CHARGE','PAYMENT') BEGIN SELECT RAISE(ABORT, 'invalid folio entry'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_update BEFORE UPDATE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_delete BEFORE DELETE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
];

async function ready(db: D1) {
  if (!initialization) initialization = initialize(db).catch(error => { initialization = null; throw error; });
  await initialization;
}

async function initialize(db: D1) {
  await db.batch(schema.map((sql) => db.prepare(sql)));
  const now = new Date().toISOString();
  await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', 'frontdesk@aurora.hotel', 'PROPERTY_ADMIN', 1, ?)").bind("role-local-admin", now).run();
  const found = await db.prepare("SELECT id FROM reservations LIMIT 1").first();
  if (found) return;
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
  await db.batch([
    db.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("fe1","prop-seoul","r3","CHARGE","ROOM","객실료",198000,null,"2026-07-14",now,"night-audit",null),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk102","prop-seoul","room-102","2026-07-15","IN_PROGRESS",1,"이지은","우선 정비",now),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk203","prop-seoul","room-203","2026-07-15","PENDING",2,null,"",now),
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

async function snapshot(db: D1, principal?: Principal | null) {
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN f.amount WHEN f.kind='PAYMENT' THEN -f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id='prop-seoul' GROUP BY r.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') WHERE rm.property_id='prop-seoul' ORDER BY rm.number`),
    principal ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email) : db.prepare("SELECT * FROM cashier_sessions WHERE 0"),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id='prop-seoul') AND r.departure_date>(SELECT business_date FROM properties WHERE id='prop-seoul') AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND f.kind='CHARGE' AND f.code='ROOM')"),
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
  return { property, reservations, rooms, metrics, principal, controls };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const snapshotCache = new Map<string,{expires:number,value:Promise<Snapshot>}>();
function invalidateSnapshots() { snapshotCache.clear(); }
async function cachedSnapshot(db:D1, principal:Principal) {
  const key=principal.email; const cached=snapshotCache.get(key); const now=Date.now();
  if (cached && cached.expires>now) return cached.value;
  const value=snapshot(db,principal); snapshotCache.set(key,{expires:now+1000,value});
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
      const room = body.roomId ? await env.DB.prepare("SELECT * FROM rooms WHERE id=? AND room_type_id=?").bind(body.roomId,body.roomTypeId).first<Record<string,unknown>>() : null;
      if (body.roomId && !room) return Response.json({error:"선택한 객실과 객실 타입이 일치하지 않습니다."},{status:409});
      const guestId=crypto.randomUUID(), reservationId=crypto.randomUUID(), confirmation=`SEL-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`;
      const statements = [
        env.DB.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', ?, '[]', ?)").bind(guestId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.nationality||"KR",now),
        env.DB.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, ?, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, ?, '', 1, ?, ?)").bind(reservationId,confirmation,guestId,body.roomTypeId,body.roomId||null,body.arrivalDate,body.departureDate,Number(body.adults)||1,Number(body.children)||0,body.source||"Direct",body.ratePlan||"BAR",Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,now,now),
      ];
      if (body.roomId) for (let d=new Date(arrival); d<departure; d.setUTCDate(d.getUTCDate()+1)) statements.push(env.DB.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomId,d.toISOString().slice(0,10)));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_RESERVATION', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,reservationId,JSON.stringify({confirmation,status:"DUE_IN"}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),reservationId,JSON.stringify({reservationId,confirmation}),now));
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
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
      const next = new Date(`${businessDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1); const nextDate=next.toISOString().slice(0,10); const auditId=crypto.randomUUID();
      const statements = [env.DB.prepare("INSERT INTO night_audits VALUES (?, 'prop-seoul', ?, 'COMPLETED', '[]', ?, ?, ?, ?)").bind(auditId,businessDate,JSON.stringify({roomPostings:stays.results.length,nextBusinessDate:nextDate}),now,now,actor)];
      for (const stay of stays.results) {
        statements.push(env.DB.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', 'ROOM', '객실료 자동 전기', ?, NULL, ?, ?, 'night-audit', NULL)").bind(crypto.randomUUID(),stay.id,stay.nightly_rate,businessDate,now));
        if (stay.room_id) statements.push(env.DB.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 2, NULL, '스테이오버 객실', ?)").bind(crypto.randomUUID(),stay.room_id,nextDate,now));
      }
      statements.push(env.DB.prepare("UPDATE properties SET business_date=? WHERE id='prop-seoul' AND business_date=?").bind(nextDate,businessDate));
      statements.push(env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_BUSINESS_DATE', 'night_audit', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,auditId,JSON.stringify({businessDate}),JSON.stringify({nextDate,roomPostings:stays.results.length}),now));
      statements.push(env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'business_date.closed', 'night_audit', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),auditId,JSON.stringify({businessDate,nextDate}),now));
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "mark_no_show" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 노쇼 처리할 수 있습니다."},{status:409});
      const statements = [
        env.DB.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'NO_SHOW', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        env.DB.prepare("UPDATE reservations SET status='NO_SHOW', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now,body.reservationId),
        env.DB.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MARK_NO_SHOW', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"NO_SHOW"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.no_show', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId}),now),
      ];
      if (idempotencyKey) statements.push(env.DB.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await env.DB.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 체크인할 수 있습니다."},{status:409});
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
        env.DB.prepare("UPDATE reservations SET status='CHECKED_OUT', version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE'").bind(now,body.reservationId),
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
    return Response.json({error:message},{status:500});
  }
}
