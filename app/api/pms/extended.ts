/** Extended PMS domains: inventory, accounting, channels and website CMS. */
import { Buffer } from "node:buffer";
import type {
  PmsDatabase,
  PmsPreparedStatement,
} from "../../../db/pms-database";

type Principal = { email: string; capabilities: string[]; propertyId: string };
type Body = Record<string, string>;

export class PmsExtendedError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(new Date(`${value}T00:00:00Z`).valueOf());
const dayDiff = (from: string, to: string) =>
  Math.floor(
    (new Date(`${to}T00:00:00Z`).valueOf() -
      new Date(`${from}T00:00:00Z`).valueOf()) /
      86400000,
  );
const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
const datePlus = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const dateRange = (from: string, to: string) =>
  Array.from({ length: dayDiff(from, to) + 1 }, (_, index) =>
    datePlus(from, index),
  );
const asNumber = (value: unknown, label: string, min = 0) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min)
    throw new PmsExtendedError(`${label} 값을 확인하세요.`);
  return round(number);
};
const parseJsonArray = (value: string | undefined) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [] as string[];
  }
};

const storageBindings = () => ({
  url: process.env.SUPABASE_URL?.replace(/\/$/u, ""),
  key: process.env.SUPABASE_SECRET_KEY,
});

/**
 * CMS input is treated as a publishing boundary: required copy is normalized and
 * length-bounded here so admin previews, the public hotel site, and stored records
 * cannot diverge because one surface silently truncated a value.
 */
function requiredCmsText(value: string | undefined, label: string, maximum: number) {
  const text = (value || "").trim();
  if (!text || text.length > maximum) throw new PmsExtendedError(`${label}은(는) 1~${maximum}자로 입력하세요.`);
  return text;
}

export async function loadWebsiteAdmin(db: PmsDatabase, propertyId: string) {
  const [settings, rooms, media] = await db.batch([
    db.prepare("SELECT * FROM website_settings WHERE property_id=? LIMIT 1").bind(propertyId),
    db.prepare("SELECT rt.id,rt.code,rt.name,rt.base_rate,rt.capacity,rt.description,rt.active,rw.published,rw.display_order,rw.marketing_name,rw.short_description,rw.long_description,rw.amenities_json,rw.version website_version FROM room_types rt LEFT JOIN room_type_website rw ON rw.property_id=rt.property_id AND rw.room_type_id=rt.id WHERE rt.property_id=? ORDER BY COALESCE(rw.published,0) DESC,COALESCE(rw.display_order,9999),rt.code").bind(propertyId),
    db.prepare("SELECT * FROM website_media WHERE property_id=? AND active=1 ORDER BY scope,room_type_id,sort_order,created_at").bind(propertyId),
  ]);
  return { settings: settings.results[0] || null, rooms: rooms.results, media: media.results };
}

async function uploadWebsiteObject(dataUrl: string, filename: string, propertyId: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match) throw new PmsExtendedError("JPEG, PNG 또는 WebP 이미지를 선택하세요.");
  const bytes = Buffer.from(match[2], "base64");
  // Base64 JSON adds roughly 33% overhead, so 3MB stays below Vercel's request-body ceiling.
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new PmsExtendedError("이미지는 3MB 이하만 업로드할 수 있습니다.", 413);
  const extension = match[1] === "image/jpeg" ? "jpg" : match[1].split("/")[1];
  const stem = filename.replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 40) || "image";
  const objectPath = `${propertyId}/${Date.now()}-${crypto.randomUUID()}-${stem}.${extension}`;
  // Only the generated property-prefixed object path is persisted. The Supabase
  // service key is read server-side and is never returned in the public URL.
  const bindings = storageBindings();
  if (!bindings.url || !bindings.key) throw new PmsExtendedError("Supabase Storage 연결이 설정되지 않았습니다.", 503);
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${bindings.url}/storage/v1/object/hotel-media/${encodedPath}`, {
    method: "POST",
    headers: { apikey: bindings.key, authorization: `Bearer ${bindings.key}`, "content-type": match[1], "x-upsert": "false" },
    body: bytes,
  });
  if (!response.ok) throw new PmsExtendedError(`이미지 저장에 실패했습니다. (${response.status})`, 502);
  return { objectPath, publicUrl: `${bindings.url}/storage/v1/object/public/hotel-media/${encodedPath}` };
}

async function deleteWebsiteObject(objectPath: string) {
  const bindings = storageBindings();
  if (!bindings.url || !bindings.key) throw new PmsExtendedError("Supabase Storage 연결이 설정되지 않았습니다.", 503);
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${bindings.url}/storage/v1/object/hotel-media/${encodedPath}`, {
    method: "DELETE",
    headers: { apikey: bindings.key, authorization: `Bearer ${bindings.key}` },
  });
  if (!response.ok && response.status !== 404) throw new PmsExtendedError(`이미지 삭제에 실패했습니다. (${response.status})`, 502);
}

function validateRange(from: string, to: string, maxDays: number) {
  if (!validDate(from) || !validDate(to) || from > to)
    throw new PmsExtendedError("시작일과 종료일을 올바르게 입력하세요.");
  if (dayDiff(from, to) >= maxDays)
    throw new PmsExtendedError(
      `한 번에 처리할 수 있는 기간은 최대 ${maxDays}일입니다.`,
    );
}

export async function loadInventoryCalendar(
  db: PmsDatabase,
  from: string,
  to: string,
  propertyId: string,
) {
  // Calendar cells are a projection, not stored availability. Each cell combines
  // physical sellable rooms, committed nights, controls, website visibility, and
  // channel-specific rate overrides so every consumer uses the same rule set.
  validateRange(from, to, 730);
  const [
    propertyResult,
    typeResult,
    roomResult,
    nightResult,
    controlResult,
    mappingResult,
    contractResult,
    ratePlanResult,
    planCalendarResult,
    rateResult,
  ] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id=? LIMIT 1").bind(propertyId),
    db
      .prepare(
        "SELECT * FROM room_types WHERE property_id=? AND active=1 ORDER BY code",
      )
      .bind(propertyId),
    db
      .prepare(
        "SELECT room_type_id,COUNT(*) physical FROM rooms WHERE property_id=? AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE' GROUP BY room_type_id",
      )
      .bind(propertyId),
    db
      .prepare(
        "SELECT room_type_id,stay_date,COUNT(*) booked FROM reservation_type_nights WHERE property_id=? AND stay_date BETWEEN ? AND ? GROUP BY room_type_id,stay_date",
      )
      .bind(propertyId, from, to),
    db
      .prepare(
        "SELECT * FROM inventory_controls WHERE property_id=? AND stay_date BETWEEN ? AND ?",
      )
      .bind(propertyId, from, to),
    db
      .prepare(
        "SELECT m.*,c.provider,c.name connection_name,rt.code room_type_code FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id JOIN room_types rt ON rt.id=m.room_type_id WHERE m.property_id=? AND m.active=1 AND c.status='ACTIVE' ORDER BY c.provider,rt.code,m.rate_plan",
      )
      .bind(propertyId),
    db
      .prepare(
        "SELECT cc.*,c.provider,c.name connection_name FROM channel_contracts cc JOIN channel_connections c ON c.id=cc.connection_id WHERE cc.property_id=? ORDER BY c.provider,c.name",
      )
      .bind(propertyId),
    db
      .prepare("SELECT * FROM rate_plans WHERE property_id=? ORDER BY active DESC,code")
      .bind(propertyId),
    db
      .prepare("SELECT rpc.*,rp.code,rp.name rate_plan_name FROM rate_plan_calendar rpc JOIN rate_plans rp ON rp.id=rpc.rate_plan_id AND rp.property_id=rpc.property_id WHERE rpc.property_id=? AND rpc.stay_date BETWEEN ? AND ? ORDER BY rp.code")
      .bind(propertyId,from,to),
    db
      .prepare(
        "SELECT * FROM channel_rate_overrides WHERE property_id=? AND stay_date BETWEEN ? AND ?",
      )
      .bind(propertyId, from, to),
  ]);
  const dates = dateRange(from, to),
    rooms = new Map(
      roomResult.results.map((row) => [
        String(row.room_type_id),
        Number(row.physical),
      ]),
    );
  const booked = new Map(
    nightResult.results.map((row) => [
      `${row.room_type_id}:${row.stay_date}`,
      Number(row.booked),
    ]),
  );
  const controls = new Map(
    controlResult.results.map((row) => [
      `${row.room_type_id}:${row.stay_date}`,
      row,
    ]),
  );
  const ratesByCell = new Map<string, Record<string, unknown>[]>();
  for (const row of rateResult.results) {
    const key = `${row.room_type_id}:${row.stay_date}`;
    ratesByCell.set(key, [...(ratesByCell.get(key) || []), row]);
  }
  const planRatesByCell = new Map<string, Record<string, unknown>[]>();
  for (const row of planCalendarResult.results) {
    const key = `${row.room_type_id}:${row.stay_date}`;
    planRatesByCell.set(key, [...(planRatesByCell.get(key) || []), row]);
  }
  const types = typeResult.results.map((type) => {
    const physical = rooms.get(String(type.id)) || 0;
    return {
      ...type,
      physical,
      cells: dates.map((stayDate) => {
        const control = controls.get(`${type.id}:${stayDate}`),
          reserved = booked.get(`${type.id}:${stayDate}`) || 0,
          sellLimit =
            control?.sell_limit == null ? physical : Number(control.sell_limit),
          closed = Boolean(control?.closed);
        return {
          stayDate,
          sellLimit,
          reserved,
          available: closed ? 0 : Math.max(0, sellLimit - reserved),
          closed,
          websiteClosed: Boolean(control?.website_closed),
          minStay: Number(control?.min_stay ?? 1),
          cta: Boolean(control?.close_to_arrival),
          ctd: Boolean(control?.close_to_departure),
          price: Number(control?.price_override ?? type.base_rate),
          ratePlanRates: planRatesByCell.get(`${type.id}:${stayDate}`) || [],
          channelRates: ratesByCell.get(`${type.id}:${stayDate}`) || [],
        };
      }),
    };
  });
  return {
    property: propertyResult.results[0],
    range: { from, to, days: dates.length },
    dates,
    types,
    mappings: mappingResult.results,
    contracts: contractResult.results,
    ratePlans: ratePlanResult.results,
  };
}

export async function loadAccountingCenter(
  db: PmsDatabase,
  from: string,
  to: string,
  propertyId: string,
) {
  // KPIs are recomputed from posted immutable journal lines and settlement facts.
  // Mutable dashboard totals are intentionally not stored because they drift when
  // a journal is reversed or a channel settlement changes state.
  validateRange(from, to, 367);
  const [
    propertyResult,
    accountResult,
    entryResult,
    lineResult,
    settlementResult,
    contractResult,
    reservationResult,
  ] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id=? LIMIT 1").bind(propertyId),
    db
      .prepare(
        "SELECT * FROM accounting_accounts WHERE property_id=? ORDER BY code",
      )
      .bind(propertyId),
    db
      .prepare(
        "SELECT e.*,COALESCE(SUM(l.debit),0) total_debit,COALESCE(SUM(l.credit),0) total_credit FROM accounting_journal_entries e LEFT JOIN accounting_journal_lines l ON l.journal_entry_id=e.id WHERE e.property_id=? AND e.business_date BETWEEN ? AND ? GROUP BY e.id ORDER BY e.business_date DESC,e.created_at DESC LIMIT 1000",
      )
      .bind(propertyId, from, to),
    db
      .prepare(
        "SELECT l.*,a.code account_code,a.name account_name,a.account_type,e.entry_no,e.business_date FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id JOIN accounting_journal_entries e ON e.id=l.journal_entry_id WHERE l.property_id=? AND e.business_date BETWEEN ? AND ? ORDER BY e.created_at DESC,l.id",
      )
      .bind(propertyId, from, to),
    db
      .prepare(
        "SELECT s.*,c.provider,c.name connection_name,r.confirmation_no FROM channel_settlements s JOIN channel_connections c ON c.id=s.connection_id LEFT JOIN reservations r ON r.id=s.reservation_id WHERE s.property_id=? AND s.business_date BETWEEN ? AND ? ORDER BY s.due_date,s.created_at DESC",
      )
      .bind(propertyId, from, to),
    db
      .prepare(
        "SELECT cc.*,c.provider,c.name connection_name FROM channel_contracts cc JOIN channel_connections c ON c.id=cc.connection_id WHERE cc.property_id=? ORDER BY c.provider,c.name",
      )
      .bind(propertyId),
    db
      .prepare(
        "SELECT r.id,r.confirmation_no,r.source,r.arrival_date,r.departure_date,r.nightly_rate,g.first_name||' '||g.last_name guest_name FROM reservations r JOIN guests g ON g.id=r.guest_id WHERE r.property_id=? AND r.status IN ('DUE_IN','IN_HOUSE','CHECKED_OUT') ORDER BY r.arrival_date DESC LIMIT 500",
      )
      .bind(propertyId),
  ]);
  const entries = entryResult.results,
    lines = lineResult.results;
  const revenue = round(
    lines
      .filter((line) => line.account_type === "REVENUE")
      .reduce((sum, line) => sum + Number(line.credit) - Number(line.debit), 0),
  );
  const expense = round(
    lines
      .filter((line) => line.account_type === "EXPENSE")
      .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0),
  );
  const receivable = round(
    settlementResult.results
      .filter((row) => row.status === "ACCRUED")
      .reduce((sum, row) => sum + Number(row.hotel_net_amount), 0),
  );
  const channelCost = round(
    settlementResult.results
      .filter((row) => row.status !== "VOID")
      .reduce((sum, row) => sum + Number(row.channel_cost_amount), 0),
  );
  return {
    property: propertyResult.results[0],
    range: { from, to },
    summary: {
      revenue,
      expense,
      operatingProfit: round(revenue - expense),
      receivable,
      channelCost,
      journalCount: entries.length,
    },
    accounts: accountResult.results,
    entries,
    lines,
    settlements: settlementResult.results,
    contracts: contractResult.results,
    reservations: reservationResult.results,
  };
}

async function commitBatches(
  db: PmsDatabase,
  statements: PmsPreparedStatement[],
) {
  // A large calendar command is one transaction. Partial rate/inventory updates
  // are more dangerous than a longer commit, and the caller already caps cells.
  await db.batch(statements);
}
function audit(
  db: PmsDatabase,
  propertyId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  after: unknown,
  now: string,
) {
  return db
    .prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
    .bind(
      crypto.randomUUID(),
      propertyId,
      actor,
      action,
      entityType,
      entityId,
      JSON.stringify(after),
      now,
    );
}
function remember(
  db: PmsDatabase,
  propertyId: string,
  key: string | undefined,
  action: string,
  actor: string,
  now: string,
) {
  // The receipt is submitted with the domain statements so a successful retry can
  // be distinguished from a failed attempt without creating duplicate side effects.
  return key
    ? db
        .prepare(
          "INSERT INTO idempotency_keys VALUES (?, ?, ?, ?, ?)",
        )
        .bind(key, propertyId, action, actor, now)
    : null;
}

async function nextJournalNo(db: PmsDatabase, propertyId: string, businessDate: string) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) count FROM accounting_journal_entries WHERE property_id=? AND business_date=?",
    )
    .bind(propertyId, businessDate)
    .first<{ count: number }>();
  return `JRN-${businessDate.replaceAll("-", "")}-${String(Number(row?.count || 0) + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

async function accountByCode(db: PmsDatabase, propertyId: string, code: string) {
  const row = await db
    .prepare(
      "SELECT * FROM accounting_accounts WHERE property_id=? AND code=? AND active=1",
    )
    .bind(propertyId, code)
    .first<Record<string, unknown>>();
  if (!row)
    throw new PmsExtendedError(`계정과목 ${code}을 찾지 못했습니다.`, 409);
  return row;
}

async function buildJournal(
  db: PmsDatabase,
  input: {
    businessDate: string;
    propertyId: string;
    entryType: string;
    sourceType: string;
    sourceId?: string;
    description: string;
    vendor?: string;
    reversalOfId?: string;
    actor: string;
    now: string;
    lines: Array<{
      accountId: string;
      debit: number;
      credit: number;
      department?: string;
      channelId?: string;
      reservationId?: string;
      memo?: string;
    }>;
  },
) {
  // Double-entry accounting is append-only: every posting must balance to the cent, and a
  // correction is represented by a new reversal journal rather than editing lines.
  // Database triggers enforce immutability after this service-level validation.
  const debit = round(input.lines.reduce((sum, line) => sum + line.debit, 0)),
    credit = round(input.lines.reduce((sum, line) => sum + line.credit, 0));
  if (!(debit > 0) || Math.abs(debit - credit) > 0.01)
    throw new PmsExtendedError("차변과 대변 합계가 일치해야 합니다.");
  const id = crypto.randomUUID(),
    entryNo = await nextJournalNo(db, input.propertyId, input.businessDate);
  const statements: PmsPreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,source_type,source_id,description,vendor,status,reversal_of_id,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,'POSTED',?,?,?)",
      )
      .bind(
        id,
        input.propertyId,
        entryNo,
        input.businessDate,
        input.entryType,
        input.sourceType,
        input.sourceId || null,
        input.description,
        input.vendor || null,
        input.reversalOfId || null,
        input.now,
        input.actor,
      ),
  ];
  for (const line of input.lines)
    statements.push(
      db
        .prepare(
          "INSERT INTO accounting_journal_lines(id,property_id,journal_entry_id,account_id,debit,credit,department,channel_connection_id,reservation_id,memo,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          input.propertyId,
          id,
          line.accountId,
          line.debit,
          line.credit,
          line.department || null,
          line.channelId || null,
          line.reservationId || null,
          line.memo || null,
          input.now,
        ),
    );
  return { id, entryNo, statements };
}

export async function handleExtendedAction(
  db: PmsDatabase,
  body: Body,
  principal: Principal,
  businessDate: string,
  now: string,
  idempotencyKey?: string | null,
) {
  // This command gateway keeps property scope, actor identity, audit records, and
  // idempotency behavior consistent across CMS, revenue, channel, and accounting
  // mutations. Authorization is resolved by the parent PMS route before entry.
  const actor = principal.email;
  const propertyId = principal.propertyId;
  if (body.action === "update_website_settings") {
    const current = await db.prepare("SELECT * FROM website_settings WHERE property_id=?").bind(propertyId).first<Record<string, unknown>>();
    if (!current) throw new PmsExtendedError("홈페이지 설정이 초기화되지 않았습니다.", 409);
    const version = Math.trunc(asNumber(body.version, "설정 버전", 1));
    if (version !== Number(current.version)) throw new PmsExtendedError("다른 관리자가 먼저 수정했습니다. 새로고침 후 다시 저장하세요.", 409);
    const values = {
      hotelName: requiredCmsText(body.hotelName, "호텔명", 100),
      brandEyebrow: requiredCmsText(body.brandEyebrow, "브랜드 문구", 120),
      heroTitle: requiredCmsText(body.heroTitle, "메인 제목", 160),
      heroSubtitle: requiredCmsText(body.heroSubtitle, "메인 설명", 500),
      overviewTitle: requiredCmsText(body.overviewTitle, "객실 섹션 제목", 160),
      overviewBody: requiredCmsText(body.overviewBody, "객실 섹션 설명", 500),
      experienceTitle: requiredCmsText(body.experienceTitle, "경험 섹션 제목", 160),
      experienceBody: requiredCmsText(body.experienceBody, "경험 섹션 설명", 500),
      locationTitle: requiredCmsText(body.locationTitle, "위치 섹션 제목", 160),
      locationBody: requiredCmsText(body.locationBody, "위치 섹션 설명", 500),
      address: requiredCmsText(body.address, "주소", 300),
      phone: requiredCmsText(body.phone, "전화번호", 40),
      email: requiredCmsText(body.email, "이메일", 254),
      checkinTime: /^\d{2}:\d{2}$/u.test(body.checkinTime || "") ? body.checkinTime : "15:00",
      checkoutTime: /^\d{2}:\d{2}$/u.test(body.checkoutTime || "") ? body.checkoutTime : "11:00",
      published: body.published === "true" ? 1 : 0,
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(values.email)) throw new PmsExtendedError("홈페이지 문의 이메일을 확인하세요.");
    const statements: PmsPreparedStatement[] = [
      db.prepare("UPDATE website_settings SET hotel_name=?,brand_eyebrow=?,hero_title=?,hero_subtitle=?,overview_title=?,overview_body=?,experience_title=?,experience_body=?,location_title=?,location_body=?,address=?,phone=?,email=?,checkin_time=?,checkout_time=?,published=?,version=version+1,updated_at=?,updated_by=? WHERE property_id=? AND version=?").bind(values.hotelName,values.brandEyebrow,values.heroTitle,values.heroSubtitle,values.overviewTitle,values.overviewBody,values.experienceTitle,values.experienceBody,values.locationTitle,values.locationBody,values.address,values.phone,values.email,values.checkinTime,values.checkoutTime,values.published,now,actor,propertyId,version),
      audit(db,propertyId,actor,"UPDATE_WEBSITE_SETTINGS","website_settings",propertyId,{...values,version:version+1},now),
    ];
    const idem=remember(db,propertyId,idempotencyKey||undefined,body.action,actor,now);if(idem)statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "update_room_type_website") {
    const roomType = await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id=? AND active=1").bind(body.roomTypeId,propertyId).first<Record<string, unknown>>();
    if (!roomType) throw new PmsExtendedError("활성 객실 타입을 찾지 못했습니다.", 404);
    const current = await db.prepare("SELECT * FROM room_type_website WHERE property_id=? AND room_type_id=?").bind(propertyId,body.roomTypeId).first<Record<string, unknown>>();
    if (current && Number(body.version) !== Number(current.version)) throw new PmsExtendedError("다른 관리자가 먼저 객실 콘텐츠를 수정했습니다.", 409);
    const amenities=parseJsonArray(body.amenities).map(item=>item.trim()).filter(Boolean).slice(0,20);
    const values={
      marketingName:requiredCmsText(body.marketingName,"홈페이지 객실명",100),
      shortDescription:requiredCmsText(body.shortDescription,"짧은 객실 소개",300),
      longDescription:requiredCmsText(body.longDescription,"상세 객실 소개",2000),
      displayOrder:Math.trunc(asNumber(body.displayOrder||"0","노출 순서")),
      published:body.published==="true"?1:0,
    };
    const statements:PmsPreparedStatement[]=[
      db.prepare("INSERT INTO room_type_website(property_id,room_type_id,published,display_order,marketing_name,short_description,long_description,amenities_json,version,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(property_id,room_type_id) DO UPDATE SET published=excluded.published,display_order=excluded.display_order,marketing_name=excluded.marketing_name,short_description=excluded.short_description,long_description=excluded.long_description,amenities_json=excluded.amenities_json,version=room_type_website.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(propertyId,body.roomTypeId,values.published,values.displayOrder,values.marketingName,values.shortDescription,values.longDescription,JSON.stringify(amenities),now,actor),
      audit(db,propertyId,actor,"UPDATE_ROOM_WEBSITE","room_type_website",body.roomTypeId,{...values,amenities},now),
    ];
    const idem=remember(db,propertyId,idempotencyKey||undefined,body.action,actor,now);if(idem)statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "upload_website_media") {
    const scope=body.scope==="ROOM_TYPE"?"ROOM_TYPE":"HOTEL",role=["HERO","GALLERY","CARD"].includes(body.role)?body.role:"GALLERY";
    const roomTypeId=scope==="ROOM_TYPE"?body.roomTypeId:null;
    if (roomTypeId&&!await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id=? AND active=1").bind(roomTypeId,propertyId).first()) throw new PmsExtendedError("이미지를 연결할 객실 타입을 찾지 못했습니다.");
    const altText=requiredCmsText(body.altText,"이미지 대체 설명",180);
    const uploaded=await uploadWebsiteObject(body.dataUrl||"",body.filename||"image",propertyId);
    const id=crypto.randomUUID(),sortOrder=Math.trunc(asNumber(body.sortOrder||"0","이미지 순서"));
    try {
      const statements:PmsPreparedStatement[]=[
        db.prepare("INSERT INTO website_media(id,property_id,scope,room_type_id,role,object_path,public_url,alt_text,sort_order,active,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)").bind(id,propertyId,scope,roomTypeId,role,uploaded.objectPath,uploaded.publicUrl,altText,sortOrder,now,actor),
        audit(db,propertyId,actor,"UPLOAD_WEBSITE_MEDIA","website_media",id,{scope,roomTypeId,role,altText,sortOrder},now),
      ];
      const idem=remember(db,propertyId,idempotencyKey||undefined,body.action,actor,now);if(idem)statements.push(idem);
      await db.batch(statements);
    } catch (error) {
      await deleteWebsiteObject(uploaded.objectPath).catch(()=>undefined);
      throw error;
    }
    return true;
  }
  if (body.action === "delete_website_media") {
    const media=await db.prepare("SELECT * FROM website_media WHERE id=? AND property_id=? AND active=1").bind(body.mediaId,propertyId).first<Record<string,unknown>>();
    if(!media)throw new PmsExtendedError("삭제할 홈페이지 이미지를 찾지 못했습니다.",404);
    await deleteWebsiteObject(String(media.object_path));
    const statements:PmsPreparedStatement[]=[
      db.prepare("DELETE FROM website_media WHERE id=? AND property_id=?").bind(body.mediaId,propertyId),
      audit(db,propertyId,actor,"DELETE_WEBSITE_MEDIA","website_media",body.mediaId,{publicUrl:media.public_url},now),
    ];
    const idem=remember(db,propertyId,idempotencyKey||undefined,body.action,actor,now);if(idem)statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "upsert_rate_plan") {
    const code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),description=(body.description||"").trim().slice(0,1000),currency=(body.currency||"KRW").trim().toUpperCase();
    if(!/^[A-Z0-9_-]{2,24}$/u.test(code)||name.length<2||name.length>100||!/^[A-Z]{3}$/u.test(currency))throw new PmsExtendedError("요금제 코드·이름·통화를 확인하세요.");
    const pricingModel=["FIXED","OFFSET","PERCENT"].includes(body.pricingModel)?body.pricingModel:"FIXED",adjustment=asNumber(body.adjustment||"0","조정값",pricingModel==="PERCENT"?-100:-100000000),minStay=Math.trunc(asNumber(body.minStay||"1","최소 숙박",1)),maxStay=Math.trunc(asNumber(body.maxStay||"30","최대 숙박",minStay));
    if(maxStay>365||(pricingModel==="PERCENT"&&adjustment>100))throw new PmsExtendedError("요금 조정값과 숙박 범위를 확인하세요.");
    const validFrom=body.validFrom||null,validTo=body.validTo||null;if((validFrom&&!validDate(validFrom))||(validTo&&!validDate(validTo))||(validFrom&&validTo&&validFrom>validTo))throw new PmsExtendedError("요금제 유효 기간을 확인하세요.");
    const current=body.ratePlanId?await db.prepare("SELECT * FROM rate_plans WHERE id=? AND property_id=?").bind(body.ratePlanId,propertyId).first<Record<string,unknown>>():null;
    if(body.ratePlanId&&!current)throw new PmsExtendedError("요금제를 찾지 못했습니다.",404);
    if(current&&Number(body.version)!==Number(current.version))throw new PmsExtendedError("다른 관리자가 요금제를 먼저 수정했습니다.",409);
    if(current&&code!==String(current.code))throw new PmsExtendedError("사용 이력이 있는 요금제 코드는 변경할 수 없습니다.",409);
    const ratePlanId=String(current?.id||crypto.randomUUID()),active=body.active==="false"?0:1,values={code,name,description,currency,pricingModel,adjustment,minStay,maxStay,validFrom,validTo,active};
    const statements:PmsPreparedStatement[]=current?[
      db.prepare("UPDATE rate_plans SET name=?,description=?,currency=?,market_segment=?,meal_plan=?,cancellation_policy=?,guarantee_policy=?,pricing_model=?,adjustment=?,min_stay=?,max_stay=?,valid_from=?,valid_to=?,active=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=? AND version=?").bind(name,description,currency,body.marketSegment||"TRANSIENT",body.mealPlan||"ROOM_ONLY",body.cancellationPolicy||"FLEXIBLE",body.guaranteePolicy||"CARD_GUARANTEE",pricingModel,adjustment,minStay,maxStay,validFrom,validTo,active,now,actor,ratePlanId,propertyId,current.version),
    ]:[
      db.prepare("INSERT INTO rate_plans(id,property_id,code,name,description,currency,market_segment,meal_plan,cancellation_policy,guarantee_policy,pricing_model,adjustment,min_stay,max_stay,valid_from,valid_to,active,version,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)").bind(ratePlanId,propertyId,code,name,description,currency,body.marketSegment||"TRANSIENT",body.mealPlan||"ROOM_ONLY",body.cancellationPolicy||"FLEXIBLE",body.guaranteePolicy||"CARD_GUARANTEE",pricingModel,adjustment,minStay,maxStay,validFrom,validTo,active,now,now,actor,actor),
      db.prepare("INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by) SELECT ?,?,id,base_rate,1,1,?,? FROM room_types WHERE property_id=? AND active=1 ON CONFLICT(property_id,rate_plan_id,room_type_id) DO NOTHING").bind(propertyId,ratePlanId,now,actor,propertyId),
    ];
    statements.push(audit(db,propertyId,actor,current?"UPDATE_RATE_PLAN":"CREATE_RATE_PLAN","rate_plan",ratePlanId,{...values,version:Number(current?.version||0)+1},now));
    const idem=remember(db,propertyId,idempotencyKey||undefined,body.action,actor,now);if(idem)statements.push(idem);await db.batch(statements);return true;
  }
  if (body.action === "bulk_update_inventory_controls") {
    const from = body.from,
      to = body.to;
    validateRange(from, to, 730);
    const selectedTypes = parseJsonArray(body.roomTypeIds);
    if (!selectedTypes.length)
      throw new PmsExtendedError("적용할 객실 타입을 하나 이상 선택하세요.");
    const weekdays = parseJsonArray(body.weekdays).map(Number);
    if (!weekdays.length)
      throw new PmsExtendedError("적용할 요일을 하나 이상 선택하세요.");
    const allDates = dateRange(from, to),
      dates = allDates.filter((date) =>
        weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
      );
    if (!dates.length)
      throw new PmsExtendedError("선택한 기간에 적용할 요일이 없습니다.");
    if (dates.length * selectedTypes.length > 5000)
      throw new PmsExtendedError(
        "한 번에 최대 5,000개 객실 타입·일자 셀을 변경할 수 있습니다.",
        413,
      );
    const typeRows = (
      await db
        .prepare(
          `SELECT rt.*,COUNT(CASE WHEN rm.active=1 AND rm.housekeeping_status<>'OUT_OF_SERVICE' THEN 1 END) physical FROM room_types rt LEFT JOIN rooms rm ON rm.room_type_id=rt.id WHERE rt.property_id=? AND rt.id IN (${selectedTypes.map(() => "?").join(",")}) GROUP BY rt.id`,
        )
        .bind(propertyId, ...selectedTypes)
        .all<Record<string, unknown>>()
    ).results;
    if (typeRows.length !== selectedTypes.length)
      throw new PmsExtendedError(
        "선택한 객실 타입 중 사용할 수 없는 항목이 있습니다.",
      );
    const existing = (
      await db
        .prepare(
          `SELECT * FROM inventory_controls WHERE property_id=? AND room_type_id IN (${selectedTypes.map(() => "?").join(",")}) AND stay_date BETWEEN ? AND ?`,
        )
        .bind(propertyId, ...selectedTypes, from, to)
        .all<Record<string, unknown>>()
    ).results;
    const reservations = (
      await db
        .prepare(
          `SELECT room_type_id,stay_date,COUNT(*) reserved FROM reservation_type_nights WHERE property_id=? AND room_type_id IN (${selectedTypes.map(() => "?").join(",")}) AND stay_date BETWEEN ? AND ? GROUP BY room_type_id,stay_date`,
        )
        .bind(propertyId, ...selectedTypes, from, to)
        .all<Record<string, unknown>>()
    ).results;
    const current = new Map(
        existing.map((row) => [`${row.room_type_id}:${row.stay_date}`, row]),
      ),
      reserved = new Map(
        reservations.map((row) => [
          `${row.room_type_id}:${row.stay_date}`,
          Number(row.reserved),
        ]),
      );
    const ratePlan=body.ratePlanId?await db.prepare("SELECT * FROM rate_plans WHERE id=? AND property_id=? AND active=1").bind(body.ratePlanId,propertyId).first<Record<string,unknown>>():null;
    if(body.ratePlanId&&!ratePlan)throw new PmsExtendedError("적용할 활성 요금제를 찾지 못했습니다.",404);
    const typeMap = new Map(typeRows.map((row) => [String(row.id), row])),
      statements: PmsPreparedStatement[] = [];
    for (const roomTypeId of selectedTypes) {
      const roomType=typeMap.get(roomTypeId)!;
      if(ratePlan)statements.push(db.prepare("INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by) VALUES (?,?,?,?,1,1,?,?) ON CONFLICT(property_id,rate_plan_id,room_type_id) DO UPDATE SET active=1,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(propertyId,ratePlan.id,roomTypeId,roomType.base_rate,now,actor));
      for (const stayDate of dates) {
        const prior = current.get(`${roomTypeId}:${stayDate}`),
          type = typeMap.get(roomTypeId)!;
        const sellLimit =
          body.sellLimit === "" || body.sellLimit == null
            ? Number(prior?.sell_limit ?? type.physical)
            : Math.trunc(asNumber(body.sellLimit, "판매 한도"));
        if (
          sellLimit < Number(reserved.get(`${roomTypeId}:${stayDate}`) || 0) ||
          sellLimit > Number(type.physical)
        )
          throw new PmsExtendedError(
            `${stayDate} 판매 한도는 확정 예약 이상, 실제 판매 가능 객실 이하로 입력하세요.`,
            409,
          );
        const price =
          body.priceOverride === "" || body.priceOverride == null
            ? Number(prior?.price_override ?? type.base_rate)
            : asNumber(body.priceOverride, "호텔 판매가");
        const minStay =
          body.minStay === "" || body.minStay == null
            ? Number(prior?.min_stay ?? 1)
            : Math.trunc(asNumber(body.minStay, "최소 숙박", 1));
        const closed =
            body.closed === "" || body.closed == null
              ? Number(prior?.closed ?? 0)
              : body.closed === "true"
                ? 1
                : 0,
          cta =
            body.cta === "" || body.cta == null
              ? Number(prior?.close_to_arrival ?? 0)
              : body.cta === "true"
                ? 1
                : 0,
          ctd =
            body.ctd === "" || body.ctd == null
              ? Number(prior?.close_to_departure ?? 0)
              : body.ctd === "true"
                ? 1
                : 0,
          websiteClosed =
            body.websiteClosed === "" || body.websiteClosed == null
              ? Number(prior?.website_closed ?? 0)
              : body.websiteClosed === "true"
                ? 1
                : 0;
        statements.push(
          db
            .prepare(
              "INSERT INTO inventory_controls(id,property_id,room_type_id,stay_date,sell_limit,closed,min_stay,close_to_arrival,close_to_departure,price_override,website_closed,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id,room_type_id,stay_date) DO UPDATE SET sell_limit=excluded.sell_limit,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,price_override=excluded.price_override,website_closed=excluded.website_closed,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
            )
            .bind(
              String(prior?.id || crypto.randomUUID()),
              propertyId,
              roomTypeId,
              stayDate,
              sellLimit,
              closed,
              minStay,
              cta,
              ctd,
              price,
              websiteClosed,
              now,
              actor,
            ),
        );
        if(ratePlan){
          const planSellRate=body.ratePlanSellRate===""||body.ratePlanSellRate==null?price:asNumber(body.ratePlanSellRate,"요금제 판매가");
          statements.push(db.prepare("INSERT INTO rate_plan_calendar(id,property_id,rate_plan_id,room_type_id,stay_date,sell_rate,closed,min_stay,close_to_arrival,close_to_departure,version,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(property_id,rate_plan_id,room_type_id,stay_date) DO UPDATE SET sell_rate=excluded.sell_rate,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,version=rate_plan_calendar.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(crypto.randomUUID(),propertyId,ratePlan.id,roomTypeId,stayDate,planSellRate,closed,Math.max(minStay,Number(ratePlan.min_stay)),cta,ctd,now,actor));
        }
      }
    }
    if (body.mappingId) {
      const mapping = await db
        .prepare(
          "SELECT * FROM channel_mappings WHERE id=? AND property_id=? AND active=1",
        )
        .bind(body.mappingId, propertyId)
        .first<Record<string, unknown>>();
      if (!mapping || !selectedTypes.includes(String(mapping.room_type_id)))
        throw new PmsExtendedError(
          "선택한 채널 요금 매핑과 객실 타입이 일치하지 않습니다.",
        );
      const contract = await db
        .prepare(
          "SELECT * FROM channel_contracts WHERE connection_id=? AND property_id=? AND status='ACTIVE'",
        )
        .bind(mapping.connection_id, propertyId)
        .first<Record<string, unknown>>();
      if (!contract)
        throw new PmsExtendedError("먼저 채널 계약 조건을 설정하세요.", 409);
      const sellRate = asNumber(body.channelSellRate, "채널 판매가"),
        netRate =
          contract.contract_type === "NET_RATE"
            ? asNumber(body.channelNetRate, "호텔 입금가")
            : null;
      if (netRate != null && netRate > sellRate)
        throw new PmsExtendedError(
          "호텔 입금가는 채널 판매가보다 클 수 없습니다.",
        );
      for (const stayDate of dates) {
        statements.push(
          db
            .prepare(
              "INSERT INTO channel_rate_overrides(id,property_id,connection_id,mapping_id,room_type_id,stay_date,sell_rate,net_rate,currency,version,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(mapping_id,stay_date) DO UPDATE SET sell_rate=excluded.sell_rate,net_rate=excluded.net_rate,currency=excluded.currency,version=channel_rate_overrides.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
            )
            .bind(
              crypto.randomUUID(),
              propertyId,
              mapping.connection_id,
              mapping.id,
              mapping.room_type_id,
              stayDate,
              sellRate,
              netRate,
              "KRW",
              now,
              actor,
            ),
        );
      }
    }
    statements.push(
      audit(
        db,
        propertyId,
        actor,
        "BULK_UPDATE_INVENTORY",
        "inventory_calendar",
        `${from}:${to}`,
        {
          from,
          to,
          days: dates.length,
          roomTypes: selectedTypes.length,
          mappingId: body.mappingId || null,
          ratePlanId: body.ratePlanId || null,
        },
        now,
      ),
    );
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await commitBatches(db, statements);
    return true;
  }
  if (body.action === "upsert_channel_contract") {
    const connection = await db
      .prepare(
        "SELECT * FROM channel_connections WHERE id=? AND property_id=? AND status='ACTIVE'",
      )
      .bind(body.connectionId, propertyId)
      .first<Record<string, unknown>>();
    if (!connection) throw new PmsExtendedError("활성 채널 연결을 선택하세요.");
    const type = body.contractType === "NET_RATE" ? "NET_RATE" : "COMMISSION",
      commission =
        type === "COMMISSION"
          ? asNumber(body.commissionPercent, "수수료율", 0.0001)
          : 0,
      cycle = ["PER_STAY", "WEEKLY", "MONTHLY"].includes(body.settlementCycle)
        ? body.settlementCycle
        : "PER_STAY",
      terms = Math.trunc(asNumber(body.paymentTermsDays || "30", "지급 조건")),
      validFrom = body.validFrom || businessDate,
      validTo = body.validTo || null;
    if (
      !validDate(validFrom) ||
      (validTo && !validDate(validTo)) ||
      (validTo && validTo < validFrom)
    )
      throw new PmsExtendedError("계약 유효 기간을 확인하세요.");
    const current = await db
        .prepare("SELECT * FROM channel_contracts WHERE connection_id=? AND property_id=?")
        .bind(body.connectionId, propertyId)
        .first<Record<string, unknown>>(),
      id = String(current?.id || crypto.randomUUID());
    const statements = [
      db
        .prepare(
          "INSERT INTO channel_contracts(id,property_id,connection_id,contract_type,commission_percent,settlement_cycle,payment_terms_days,currency,valid_from,valid_to,status,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,'ACTIVE',1,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET contract_type=excluded.contract_type,commission_percent=excluded.commission_percent,settlement_cycle=excluded.settlement_cycle,payment_terms_days=excluded.payment_terms_days,currency=excluded.currency,valid_from=excluded.valid_from,valid_to=excluded.valid_to,status='ACTIVE',version=channel_contracts.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        )
        .bind(
          id,
          propertyId,
          body.connectionId,
          type,
          commission,
          cycle,
          terms,
          "KRW",
          validFrom,
          validTo,
          now,
          actor,
          now,
          actor,
        ),
      audit(
        db,
        propertyId,
        actor,
        "UPSERT_CHANNEL_CONTRACT",
        "channel_contract",
        id,
        {
          connectionId: body.connectionId,
          type,
          commission,
          cycle,
          terms,
          validFrom,
          validTo,
        },
        now,
      ),
    ];
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "post_accounting_entry") {
    if (!validDate(body.businessDate || businessDate))
      throw new PmsExtendedError("영업일을 확인하세요.");
    const amount = asNumber(body.amount, "전표 금액", 0.01),
      debit = await db
        .prepare(
          "SELECT * FROM accounting_accounts WHERE id=? AND property_id=? AND active=1",
        )
        .bind(body.debitAccountId, propertyId)
        .first<Record<string, unknown>>(),
      credit = await db
        .prepare(
          "SELECT * FROM accounting_accounts WHERE id=? AND property_id=? AND active=1",
        )
        .bind(body.creditAccountId, propertyId)
        .first<Record<string, unknown>>();
    if (!debit || !credit || debit.id === credit.id)
      throw new PmsExtendedError("서로 다른 활성 차변·대변 계정을 선택하세요.");
    const description = (body.description || "").trim();
    if (description.length < 2)
      throw new PmsExtendedError("전표 적요를 두 글자 이상 입력하세요.");
    const journal = await buildJournal(db, {
      propertyId,
      businessDate: body.businessDate || businessDate,
      entryType: ["REVENUE", "EXPENSE", "ADJUSTMENT"].includes(body.entryType)
        ? body.entryType
        : "ADJUSTMENT",
      sourceType: "MANUAL",
      description,
      vendor: (body.vendor || "").trim(),
      actor,
      now,
      lines: [
        {
          accountId: String(debit.id),
          debit: amount,
          credit: 0,
          department: body.department,
          memo: description,
        },
        {
          accountId: String(credit.id),
          debit: 0,
          credit: amount,
          department: body.department,
          memo: description,
        },
      ],
    });
    const statements: PmsPreparedStatement[] = [
      ...journal.statements,
      audit(
        db,
        propertyId,
        actor,
        "POST_ACCOUNTING_ENTRY",
        "accounting_journal",
        journal.id,
        { entryNo: journal.entryNo, amount, description },
        now,
      ),
    ];
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "reverse_accounting_entry") {
    const entry = await db
      .prepare(
        "SELECT * FROM accounting_journal_entries WHERE id=? AND property_id=?",
      )
      .bind(body.entryId, propertyId)
      .first<Record<string, unknown>>();
    if (!entry) throw new PmsExtendedError("원전표를 찾지 못했습니다.", 404);
    if (entry.status !== "POSTED")
      throw new PmsExtendedError("이미 반대 처리된 전표입니다.", 409);
    const reason = (body.reason || "").trim();
    if (reason.length < 2)
      throw new PmsExtendedError("반대전표 사유를 입력하세요.");
    const lines = (
      await db
        .prepare(
          "SELECT * FROM accounting_journal_lines WHERE journal_entry_id=? AND property_id=?",
        )
        .bind(entry.id, propertyId)
        .all<Record<string, unknown>>()
    ).results;
    const reversal = await buildJournal(db, {
      propertyId,
      businessDate: businessDate,
      entryType: "REVERSAL",
      sourceType: "JOURNAL_REVERSAL",
      sourceId: String(entry.id),
      description: `${entry.entry_no} 반대: ${reason}`,
      reversalOfId: String(entry.id),
      actor,
      now,
      lines: lines.map((line) => ({
        accountId: String(line.account_id),
        debit: Number(line.credit),
        credit: Number(line.debit),
        department: String(line.department || ""),
        channelId: String(line.channel_connection_id || ""),
        reservationId: String(line.reservation_id || ""),
        memo: reason,
      })),
    });
    const statements: PmsPreparedStatement[] = [
      ...reversal.statements,
      db
        .prepare(
          "UPDATE accounting_journal_entries SET status='REVERSED' WHERE id=? AND property_id=? AND status='POSTED'",
        )
        .bind(entry.id, propertyId),
      audit(
        db,
        propertyId,
        actor,
        "REVERSE_ACCOUNTING_ENTRY",
        "accounting_journal",
        String(entry.id),
        { reversalId: reversal.id, reason },
        now,
      ),
    ];
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "accrue_channel_settlement") {
    const contract = await db
        .prepare(
          "SELECT * FROM channel_contracts WHERE connection_id=? AND property_id=? AND status='ACTIVE'",
        )
        .bind(body.connectionId, propertyId)
        .first<Record<string, unknown>>(),
      reservation = await db
        .prepare("SELECT * FROM reservations WHERE id=? AND property_id=?")
        .bind(body.reservationId, propertyId)
        .first<Record<string, unknown>>();
    if (!contract || !reservation)
      throw new PmsExtendedError("채널 계약과 예약을 확인하세요.");
    const nights = Math.max(
        1,
        dayDiff(
          String(reservation.arrival_date),
          String(reservation.departure_date),
        ),
      );
    const rateSummary = await db
      .prepare(
        "SELECT o.mapping_id,m.rate_plan,SUM(o.sell_rate) gross,SUM(COALESCE(o.net_rate,0)) net,COUNT(*) nights,SUM(CASE WHEN o.net_rate IS NOT NULL THEN 1 ELSE 0 END) net_nights FROM channel_rate_overrides o JOIN channel_mappings m ON m.id=o.mapping_id AND m.property_id=o.property_id WHERE o.connection_id=? AND o.room_type_id=? AND o.property_id=? AND o.stay_date>=? AND o.stay_date<? GROUP BY o.mapping_id,m.rate_plan HAVING COUNT(*)=? ORDER BY CASE WHEN m.rate_plan=? THEN 0 ELSE 1 END,o.mapping_id LIMIT 1",
      )
      .bind(
        body.connectionId,
        reservation.room_type_id,
        propertyId,
        reservation.arrival_date,
        reservation.departure_date,
        nights,
        reservation.rate_plan,
      )
      .first<Record<string, unknown>>();
    const gross = round(
      rateSummary
        ? Number(rateSummary.gross)
        : Number(reservation.nightly_rate) * nights,
    );
    let hotelNet = 0;
    if (contract.contract_type === "COMMISSION")
      hotelNet = round(gross * (1 - Number(contract.commission_percent) / 100));
    else {
      if (!rateSummary || Number(rateSummary.net_nights) !== nights)
        throw new PmsExtendedError(
          "입금가 계약은 모든 투숙일의 채널 입금가가 필요합니다.",
          409,
        );
      hotelNet = round(Number(rateSummary.net));
    }
    const cost = round(gross - hotelNet);
    if (cost < 0)
      throw new PmsExtendedError("채널 비용 계산값이 올바르지 않습니다.");
    const settlementId = crypto.randomUUID(),
      dueDate = datePlus(businessDate, Number(contract.payment_terms_days));
    const receivable = await accountByCode(db, propertyId, "1200"),
      revenue = await accountByCode(db, propertyId, "4100"),
      expense = await accountByCode(db, propertyId, "5100"),
      payable =
        contract.contract_type === "COMMISSION"
          ? await accountByCode(db, propertyId, "2200")
          : null;
    const lines =
      contract.contract_type === "COMMISSION"
        ? [
            {
              accountId: String(receivable.id),
              debit: gross,
              credit: 0,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
            {
              accountId: String(revenue.id),
              debit: 0,
              credit: gross,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
            {
              accountId: String(expense.id),
              debit: cost,
              credit: 0,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
            {
              accountId: String(payable!.id),
              debit: 0,
              credit: cost,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
          ]
        : [
            {
              accountId: String(receivable.id),
              debit: hotelNet,
              credit: 0,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
            {
              accountId: String(expense.id),
              debit: cost,
              credit: 0,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
            {
              accountId: String(revenue.id),
              debit: 0,
              credit: gross,
              channelId: body.connectionId,
              reservationId: body.reservationId,
            },
          ];
    const journal = await buildJournal(db, {
      propertyId,
      businessDate,
      entryType: "CHANNEL_SETTLEMENT",
      sourceType: "CHANNEL_ACCRUAL",
      sourceId: settlementId,
      description: `${reservation.confirmation_no} 채널 정산 발생`,
      actor,
      now,
      lines,
    });
    const statements: PmsPreparedStatement[] = [
      db
        .prepare(
          "INSERT INTO channel_settlements(id,property_id,contract_id,connection_id,reservation_id,business_date,gross_sell_amount,channel_cost_amount,hotel_net_amount,currency,due_date,status,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?, 'KRW',?,'ACCRUED',?,?,?,?)",
        )
        .bind(
          settlementId,
          propertyId,
          contract.id,
          body.connectionId,
          body.reservationId,
          businessDate,
          gross,
          cost,
          hotelNet,
          dueDate,
          now,
          actor,
          now,
          actor,
        ),
      ...journal.statements,
      audit(
        db,
        propertyId,
        actor,
        "ACCRUE_CHANNEL_SETTLEMENT",
        "channel_settlement",
        settlementId,
        { gross, cost, hotelNet, journalId: journal.id },
        now,
      ),
    ];
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await db.batch(statements);
    return true;
  }
  if (body.action === "mark_channel_settlement_paid") {
    const settlement = await db
      .prepare(
        "SELECT s.*,cc.contract_type FROM channel_settlements s JOIN channel_contracts cc ON cc.id=s.contract_id WHERE s.id=? AND s.property_id=?",
      )
      .bind(body.settlementId, propertyId)
      .first<Record<string, unknown>>();
    if (!settlement)
      throw new PmsExtendedError("채널 정산 건을 찾지 못했습니다.", 404);
    if (settlement.status !== "ACCRUED")
      throw new PmsExtendedError(
        "발생 상태의 정산만 지급 완료할 수 있습니다.",
        409,
      );
    const cash = await accountByCode(db, propertyId, "1100"),
      receivable = await accountByCode(db, propertyId, "1200"),
      lines = [
        {
          accountId: String(cash.id),
          debit: Number(settlement.hotel_net_amount),
          credit: 0,
          channelId: String(settlement.connection_id),
          reservationId: String(settlement.reservation_id || ""),
        },
        {
          accountId: String(receivable.id),
          debit: 0,
          credit: Number(settlement.hotel_net_amount),
          channelId: String(settlement.connection_id),
          reservationId: String(settlement.reservation_id || ""),
        },
      ];
    if (
      settlement.contract_type === "COMMISSION" &&
      Number(settlement.channel_cost_amount) > 0
    ) {
      const payable = await accountByCode(db, propertyId, "2200");
      lines.push(
        {
          accountId: String(payable.id),
          debit: Number(settlement.channel_cost_amount),
          credit: 0,
          channelId: String(settlement.connection_id),
          reservationId: String(settlement.reservation_id || ""),
        },
        {
          accountId: String(cash.id),
          debit: 0,
          credit: Number(settlement.channel_cost_amount),
          channelId: String(settlement.connection_id),
          reservationId: String(settlement.reservation_id || ""),
        },
      );
    }
    const journal = await buildJournal(db, {
      propertyId,
      businessDate,
      entryType: "CHANNEL_SETTLEMENT",
      sourceType: "CHANNEL_PAYMENT",
      sourceId: String(settlement.id),
      description: `채널 정산 지급 ${settlement.id}`,
      actor,
      now,
      lines,
    });
    const statements: PmsPreparedStatement[] = [
      ...journal.statements,
      db
        .prepare(
          "UPDATE channel_settlements SET status='PAID',paid_at=?,updated_at=?,updated_by=? WHERE id=? AND property_id=? AND status='ACCRUED'",
        )
        .bind(now, now, actor, settlement.id, propertyId),
      audit(
        db,
        propertyId,
        actor,
        "PAY_CHANNEL_SETTLEMENT",
        "channel_settlement",
        String(settlement.id),
        { journalId: journal.id },
        now,
      ),
    ];
    const idem = remember(
      db,
      propertyId,
      idempotencyKey || undefined,
      body.action,
      actor,
      now,
    );
    if (idem) statements.push(idem);
    await db.batch(statements);
    return true;
  }
  return false;
}
