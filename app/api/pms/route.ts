import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";
type D1 = typeof env.DB;

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
  `CREATE UNIQUE INDEX IF NOT EXISTS room_number_uq ON rooms(property_id, number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS confirmation_uq ON reservations(property_id, confirmation_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_night_uq ON reservation_nights(property_id, room_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS arrival_idx ON reservations(property_id, arrival_date, status)`,
  `CREATE INDEX IF NOT EXISTS hk_board_idx ON housekeeping_tasks(property_id, business_date, status)`,
  `CREATE INDEX IF NOT EXISTS folio_reservation_idx ON folio_entries(reservation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, created_at)`,
];

async function ready(db: D1) {
  await db.batch(schema.map((sql) => db.prepare(sql)));
  const found = await db.prepare("SELECT id FROM reservations LIMIT 1").first();
  if (found) return;
  const now = new Date().toISOString();
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

async function snapshot(db: D1) {
  const property = await db.prepare("SELECT * FROM properties LIMIT 1").first();
  const reservations = await db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN f.amount ELSE -f.amount END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id GROUP BY r.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`).all();
  const rooms = await db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties LIMIT 1) ORDER BY rm.number`).all();
  const metrics = await db.prepare(`SELECT COUNT(*) rooms, SUM(front_desk_status='OCCUPIED') occupied, SUM(housekeeping_status='DIRTY') dirty, SUM(housekeeping_status='CLEAN' OR housekeeping_status='INSPECTED') ready FROM rooms`).first();
  return { property, reservations: reservations.results, rooms: rooms.results, metrics };
}

export async function GET() {
  await ready(env.DB); return Response.json(await snapshot(env.DB), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  await ready(env.DB); const body = await request.json() as Record<string, string>; const now = new Date().toISOString(); const actor = request.headers.get("oai-authenticated-user-email") || "frontdesk@aurora.hotel";
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    const duplicate = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key=?").bind(idempotencyKey).first();
    if (duplicate) return Response.json(await snapshot(env.DB), {headers:{"X-Idempotent-Replay":"true"}});
  }
  const reservation = body.reservationId ? await env.DB.prepare("SELECT * FROM reservations WHERE id=?").bind(body.reservationId).first<Record<string, unknown>>() : null;
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
      await env.DB.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (!reservation.room_id) return Response.json({error:"객실 배정이 필요합니다."},{status:409});
      const room = await env.DB.prepare("SELECT * FROM rooms WHERE id=?").bind(reservation.room_id).first<Record<string, unknown>>();
      if (!room || !["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"청소 완료 또는 점검 완료 객실만 체크인할 수 있습니다."},{status:409});
      await env.DB.batch([
        env.DB.prepare("UPDATE reservations SET status='IN_HOUSE', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now, body.reservationId),
        env.DB.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=?").bind(reservation.room_id),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_IN","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"IN_HOUSE"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_in', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
      ]);
    } else if (body.action === "check_out" && reservation) {
      const bal = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount ELSE -amount END),0) balance FROM folio_entries WHERE reservation_id=?").bind(body.reservationId).first<{balance:number}>();
      if (Math.abs(bal?.balance ?? 0) > .01) return Response.json({error:"잔액을 정산한 뒤 체크아웃하세요."},{status:409});
      const task = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("UPDATE reservations SET status='CHECKED_OUT', version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE'").bind(now,body.reservationId),
        env.DB.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=?").bind(reservation.room_id),
        env.DB.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, 'PENDING', 1, NULL, '체크아웃 객실', ?)").bind(task,"prop-seoul",reservation.room_id,"2026-07-15",now),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_OUT","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CHECKED_OUT"}),now),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_out', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
      ]);
    } else if (body.action === "post_payment" && reservation) {
      const amount = Number(body.amount); if (!(amount > 0)) return Response.json({error:"결제 금액이 올바르지 않습니다."},{status:400});
      await env.DB.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, 'PAYMENT', 'PAYMENT', '프런트 결제', ?, ?, '2026-07-15', ?, ?, NULL)").bind(crypto.randomUUID(),"prop-seoul",body.reservationId,amount,body.method || "CARD",now,actor).run();
    } else if (body.action === "post_charge" && reservation) {
      const amount=Number(body.amount); if(!(amount>0)) return Response.json({error:"전기 금액이 올바르지 않습니다."},{status:400});
      await env.DB.batch([
        env.DB.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, '2026-07-15', ?, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,body.code||"MISC",body.description||"기타 매출",amount,now,actor),
        env.DB.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,kind:"CHARGE"}),now),
      ]);
    } else if (body.action === "housekeeping") {
      const status = body.status === "INSPECTED" ? "INSPECTED" : "CLEAN";
      await env.DB.batch([
        env.DB.prepare("UPDATE rooms SET housekeeping_status=?, version=version+1 WHERE id=?").bind(status,body.roomId),
        env.DB.prepare("UPDATE housekeeping_tasks SET status='DONE', updated_at=? WHERE room_id=? AND business_date='2026-07-15'").bind(now,body.roomId),
        env.DB.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"HOUSEKEEPING_COMPLETE","room",body.roomId,JSON.stringify({housekeepingStatus:status}),now),
      ]);
    } else return Response.json({error:"지원하지 않는 작업입니다."},{status:400});
    if (idempotencyKey) await env.DB.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now).run();
    return Response.json(await snapshot(env.DB));
  } catch (error) {
    const message=error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    if (message.includes("room_night_uq") || message.includes("reservation_nights.property_id")) return Response.json({error:"선택한 객실은 해당 일정에 이미 예약되어 있습니다. 다른 객실을 선택하세요."},{status:409});
    return Response.json({error:message},{status:500});
  }
}
