/** Bounded read models for the operational search, front desk, and booking flow. */

import type { PmsDatabase } from "../../../db/pms-database";
import type { Principal } from "./auth";
import { canViewWorkspace } from "../../access-control";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const QUEUES = ["TODAY", "ALL", "DUE_IN", "IN_HOUSE", "DUE_OUT", "UNASSIGNED", "BALANCE"] as const;
const STATUSES = ["", "DUE_IN", "IN_HOUSE", "CHECKED_OUT", "CANCELLED", "NO_SHOW"] as const;
const DATE_FIELDS = ["arrival", "departure"] as const;
const ASSIGNMENTS = ["ALL", "ASSIGNED", "UNASSIGNED"] as const;
const BALANCES = ["ALL", "DUE", "CLEAR"] as const;
const SORTS = ["eta", "arrival", "departure", "updated"] as const;

type Queue = (typeof QUEUES)[number];
type DateField = (typeof DATE_FIELDS)[number];

export type FrontdeskQuery = {
  focus: string;
  q: string;
  queue: Queue;
  status: (typeof STATUSES)[number];
  dateField: DateField;
  from: string;
  to: string;
  source: string;
  roomTypeId: string;
  assignment: (typeof ASSIGNMENTS)[number];
  balance: (typeof BALANCES)[number];
  sort: (typeof SORTS)[number];
  page: number;
  pageSize: number;
};

export class PmsReadError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function enumValue<T extends readonly string[]>(
  values: T,
  candidate: string | null,
  fallback: T[number],
): T[number] {
  return values.includes(candidate as T[number]) ? (candidate as T[number]) : fallback;
}

/** Converts URL input into a small, closed query contract before SQL is built. */
export function parseFrontdeskQuery(input: URLSearchParams): FrontdeskQuery {
  const rawFrom = input.get("from") || "";
  const rawTo = input.get("to") || "";
  const from = ISO_DATE.test(rawFrom) ? rawFrom : "";
  const to = ISO_DATE.test(rawTo) ? rawTo : "";
  if (from && to && to < from) throw new PmsReadError("종료일은 시작일보다 빠를 수 없습니다.");
  return {
    focus: (input.get("focus") || "").trim().slice(0, 80),
    q: (input.get("q") || "").trim().slice(0, 120),
    queue: enumValue(QUEUES, input.get("queue"), "TODAY"),
    status: enumValue(STATUSES, input.get("status"), ""),
    dateField: enumValue(DATE_FIELDS, input.get("dateField"), "arrival"),
    from,
    to,
    source: (input.get("source") || "").trim().slice(0, 80),
    roomTypeId: (input.get("roomTypeId") || "").trim().slice(0, 80),
    assignment: enumValue(ASSIGNMENTS, input.get("assignment"), "ALL"),
    balance: enumValue(BALANCES, input.get("balance"), "ALL"),
    sort: enumValue(SORTS, input.get("sort"), "eta"),
    page: Math.max(1, Math.min(10_000, Number(input.get("page")) || 1)),
    pageSize: Math.max(10, Math.min(50, Number(input.get("pageSize")) || 20)),
  };
}

const reservationRowsCte = `
WITH external_refs AS (
  SELECT reservation_id,MIN(external_reservation_id) external_reservation_id
  FROM channel_reservation_links
  WHERE property_id=pms_current_property_id()
  GROUP BY reservation_id
), folio_totals AS (
  SELECT reservation_id,COALESCE(SUM(CASE kind
    WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount
    WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount
    WHEN 'REFUND' THEN amount ELSE 0 END),0) balance
  FROM folio_entries
  WHERE property_id=pms_current_property_id()
  GROUP BY reservation_id
), reservation_rows AS (
  SELECT r.*,g.first_name,g.last_name,g.vip_level,g.email,g.phone,
    rm.number room_number,rt.code room_type_code,rt.name room_type_name,
    COALESCE(ft.balance,0) balance,er.external_reservation_id
  FROM reservations r
  JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
  JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
  LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id
  LEFT JOIN folio_totals ft ON ft.reservation_id=r.id
  LEFT JOIN external_refs er ON er.reservation_id=r.id
  WHERE r.property_id=pms_current_property_id()
)
`;

function frontdeskWhere(query: FrontdeskQuery) {
  const clauses: string[] = ["1=1"];
  const binds: unknown[] = [];
  if (query.focus) {
    clauses.push("x.id=?");
    binds.push(query.focus);
  }
  if (!query.focus && query.queue === "TODAY")
    clauses.push("((x.status='DUE_IN' AND x.arrival_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id())) OR x.status='IN_HOUSE')");
  if (!query.focus && query.queue === "DUE_IN") clauses.push("x.status='DUE_IN'");
  if (!query.focus && query.queue === "IN_HOUSE") clauses.push("x.status='IN_HOUSE'");
  if (!query.focus && query.queue === "DUE_OUT")
    clauses.push("x.status='IN_HOUSE' AND x.departure_date<=(SELECT business_date FROM properties WHERE id=pms_current_property_id())");
  if (!query.focus && query.queue === "UNASSIGNED") clauses.push("x.status='DUE_IN' AND x.room_id IS NULL");
  if (!query.focus && query.queue === "BALANCE") clauses.push("x.balance<>0");
  if (query.status) {
    clauses.push("x.status=?");
    binds.push(query.status);
  }
  if (query.q) {
    clauses.push("LOWER(CONCAT_WS(' ',x.first_name,x.last_name,x.confirmation_no,COALESCE(x.room_number,''),COALESCE(x.phone,''),COALESCE(x.email,''),COALESCE(x.external_reservation_id,''))) LIKE ?");
    binds.push(`%${query.q.toLocaleLowerCase("ko-KR")}%`);
  }
  const dateColumn = query.dateField === "departure" ? "x.departure_date" : "x.arrival_date";
  if (query.from) {
    clauses.push(`${dateColumn}>=?`);
    binds.push(query.from);
  }
  if (query.to) {
    clauses.push(`${dateColumn}<=?`);
    binds.push(query.to);
  }
  if (query.source) {
    clauses.push("LOWER(x.source) LIKE ?");
    binds.push(`%${query.source.toLocaleLowerCase("ko-KR")}%`);
  }
  if (query.roomTypeId) {
    clauses.push("x.room_type_id=?");
    binds.push(query.roomTypeId);
  }
  if (query.assignment === "ASSIGNED") clauses.push("x.room_id IS NOT NULL");
  if (query.assignment === "UNASSIGNED") clauses.push("x.room_id IS NULL");
  if (query.balance === "DUE") clauses.push("x.balance<>0");
  if (query.balance === "CLEAR") clauses.push("x.balance=0");
  return { sql: `WHERE ${clauses.join(" AND ")}`, binds };
}

function maskReservationRows(rows: Array<Record<string, unknown>>, principal: Principal) {
  if (principal.piiMode !== "MASKED") return rows;
  return rows.map((row) => ({
    ...row,
    first_name: `${String(row.first_name || "").slice(0, 1)}**`,
    last_name: `${String(row.last_name || "").slice(0, 1)}**`,
    email: "masked@support.invalid",
    phone: "***-****-****",
    notes: "지원 조회에서 마스킹됨",
  }));
}

/** Server-side pagination prevents a long-running property from hydrating years of stays. */
export async function loadFrontdesk(
  db: PmsDatabase,
  params: URLSearchParams,
  principal: Principal,
) {
  const query = parseFrontdeskQuery(params);
  const where = frontdeskWhere(query);
  const order = {
    eta: "CASE x.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END,x.arrival_date,COALESCE(x.eta,'23:59'),x.updated_at DESC",
    arrival: "x.arrival_date,x.last_name,x.first_name",
    departure: "x.departure_date,x.last_name,x.first_name",
    updated: "x.updated_at DESC",
  }[query.sort];
  const [countResult, rowResult, queueResult, typeResult, sourceResult] = await db.batch([
    db.prepare(`${reservationRowsCte} SELECT COUNT(*) count FROM reservation_rows x ${where.sql}`).bind(...where.binds),
    db.prepare(`${reservationRowsCte} SELECT x.* FROM reservation_rows x ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...where.binds, query.pageSize, (query.page - 1) * query.pageSize),
    db.prepare(`${reservationRowsCte} SELECT COUNT(*) total,
      SUM(CASE WHEN x.status='DUE_IN' AND x.arrival_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) THEN 1 ELSE 0 END) due_in,
      SUM(CASE WHEN x.status='IN_HOUSE' THEN 1 ELSE 0 END) in_house,
      SUM(CASE WHEN x.status='IN_HOUSE' AND x.departure_date<=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) THEN 1 ELSE 0 END) due_out,
      SUM(CASE WHEN x.status='DUE_IN' AND x.room_id IS NULL THEN 1 ELSE 0 END) unassigned,
      SUM(CASE WHEN x.balance<>0 THEN 1 ELSE 0 END) balance_due
      FROM reservation_rows x`),
    db.prepare("SELECT id,code,name FROM room_types WHERE property_id=pms_current_property_id() AND active ORDER BY code"),
    db.prepare("SELECT source,COUNT(*) count FROM reservations WHERE property_id=pms_current_property_id() GROUP BY source ORDER BY count DESC,source LIMIT 30"),
  ]);
  const total = Number((countResult.results[0] as { count?: number })?.count ?? 0);
  return {
    query,
    rows: maskReservationRows(rowResult.results, principal),
    queues: queueResult.results[0] ?? {},
    roomTypes: typeResult.results,
    sources: sourceResult.results,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

function contactHint(row: Record<string, unknown>, principal: Principal) {
  if (principal.piiMode === "MASKED") return "개인정보 마스킹됨";
  const phone = String(row.phone || "").replace(/\D/gu, "");
  if (phone) return `연락처 끝 ${phone.slice(-4)}`;
  const email = String(row.email || "");
  if (email.includes("@")) return `${email.slice(0, 2)}***@${email.split("@")[1]}`;
  return "";
}

/** Cross-domain search returns navigation targets, never mutable domain objects. */
export async function loadPmsSearch(
  db: PmsDatabase,
  params: URLSearchParams,
  principal: Principal,
) {
  const q = (params.get("q") || "").trim().slice(0, 120);
  if (q.length < 2) return { q, groups: [], total: 0 };
  const pattern = `%${q.toLocaleLowerCase("ko-KR")}%`;
  // Domain-level read flags are bound into every query so opening the global
  // search never broadens a narrow staff member's workspace permissions.
  const maySearchReservations = canViewWorkspace(principal.workspaceAccess, "frontdesk");
  const maySearchRooms = canViewWorkspace(principal.workspaceAccess, "rooms");
  const maySearchFinance = canViewWorkspace(principal.workspaceAccess, "finance");
  const [reservations, rooms, finance] = await db.batch([
    db.prepare(`SELECT r.id,r.confirmation_no,r.status,r.arrival_date,r.departure_date,r.source,
      g.first_name,g.last_name,g.email,g.phone,rm.number room_number,
      rt.name room_type_name,er.external_reservation_id
      FROM reservations r
      JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
      LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id
      LEFT JOIN (SELECT reservation_id,MIN(external_reservation_id) external_reservation_id FROM channel_reservation_links WHERE property_id=pms_current_property_id() GROUP BY reservation_id) er ON er.reservation_id=r.id
      WHERE r.property_id=pms_current_property_id() AND ?
        AND LOWER(CONCAT_WS(' ',r.confirmation_no,g.first_name,g.last_name,COALESCE(g.phone,''),COALESCE(g.email,''),COALESCE(rm.number,''),COALESCE(er.external_reservation_id,''))) LIKE ?
      ORDER BY r.updated_at DESC LIMIT 8`).bind(maySearchReservations, pattern),
    db.prepare(`SELECT rm.id,rm.number,rm.front_desk_status,rm.housekeeping_status,rt.code,rt.name
      FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id AND rt.property_id=rm.property_id
      WHERE rm.property_id=pms_current_property_id() AND ? AND rm.active
        AND LOWER(CONCAT_WS(' ',rm.number,rt.code,rt.name,rm.floor)) LIKE ?
      ORDER BY rm.number LIMIT 6`).bind(maySearchRooms, pattern),
    db.prepare(`SELECT i.id,i.invoice_no,i.status,
        COALESCE(SUM(l.debit-l.credit),0) balance,a.name account_name
      FROM ar_invoices i JOIN ar_accounts a ON a.id=i.ar_account_id AND a.property_id=i.property_id
      LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id AND l.property_id=i.property_id
      WHERE i.property_id=pms_current_property_id() AND ?
        AND LOWER(CONCAT_WS(' ',i.invoice_no,a.account_no,a.name)) LIKE ?
      GROUP BY i.id,a.id ORDER BY i.issued_date DESC LIMIT 6`).bind(maySearchFinance, pattern),
  ]);
  const reservationItems = reservations.results.map((row) => ({
    id: String(row.id),
    kind: "RESERVATION",
    title: principal.piiMode === "MASKED"
      ? `${String(row.first_name || "").slice(0, 1)}** ${String(row.last_name || "").slice(0, 1)}**`
      : `${row.first_name} ${row.last_name}`,
    subtitle: `${row.confirmation_no} · ${row.arrival_date} → ${row.departure_date}`,
    meta: [row.room_number || "미배정", row.source, contactHint(row, principal)].filter(Boolean).join(" · "),
    path: `/frontdesk?focus=${encodeURIComponent(String(row.id))}`,
  }));
  const roomItems = rooms.results.map((row) => ({
    id: String(row.id), kind: "ROOM", title: `${row.number}호 · ${row.name}`,
    subtitle: `${row.code} · ${row.front_desk_status}`, meta: String(row.housekeeping_status),
    path: `/rooms?focus=${encodeURIComponent(String(row.id))}`,
  }));
  const financeItems = finance.results.map((row) => ({
    id: String(row.id), kind: "AR", title: String(row.invoice_no),
    subtitle: String(row.account_name), meta: `${row.status} · ${Number(row.balance).toLocaleString("ko-KR")}원`,
    path: `/finance?focus=${encodeURIComponent(String(row.id))}`,
  }));
  const groups = [
    { id: "reservations", label: "예약·고객", items: reservationItems },
    { id: "rooms", label: "객실", items: roomItems },
    { id: "finance", label: "정산·미수금", items: financeItems },
  ].filter((group) => group.items.length > 0);
  return { q, groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) };
}

function stayDates(arrival: string, departure: string) {
  if (!ISO_DATE.test(arrival) || !ISO_DATE.test(departure)) return [];
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  const output: string[] = [];
  for (const cursor = new Date(start); cursor < end && output.length <= 30; cursor.setUTCDate(cursor.getUTCDate() + 1))
    output.push(cursor.toISOString().slice(0, 10));
  return end > start && output.length <= 30 ? output : [];
}

function calculatedPlanRate(typeBase: number, plan: Record<string, unknown>, roomBase: unknown) {
  if (roomBase != null) return Number(roomBase);
  const adjustment = Number(plan.adjustment || 0);
  if (plan.pricing_model === "OFFSET") return Math.max(0, typeBase + adjustment);
  if (plan.pricing_model === "PERCENT") return Math.max(0, Math.round(typeBase * (1 + adjustment / 100)));
  return typeBase;
}

/** Authoritative staff availability projection used before creating a reservation. */
export async function loadReservationAvailability(db: PmsDatabase, params: URLSearchParams) {
  const arrival = params.get("arrival") || "";
  const departure = params.get("departure") || "";
  const adults = Math.max(1, Math.min(20, Number(params.get("adults")) || 1));
  const children = Math.max(0, Math.min(12, Number(params.get("children")) || 0));
  const dates = stayDates(arrival, departure);
  if (!dates.length) throw new PmsReadError("올바른 체크인·체크아웃 날짜를 입력하세요. 최대 30박까지 조회할 수 있습니다.");
  const [property, types, controls, sold, held, plans, roomPlans, planCalendar] = await db.batch([
    db.prepare("SELECT name,currency,business_date FROM properties WHERE id=pms_current_property_id() LIMIT 1"),
    db.prepare(`SELECT rt.id,rt.code,rt.name,rt.base_rate,rt.capacity,COUNT(rm.id) physical
      FROM room_types rt LEFT JOIN rooms rm ON rm.room_type_id=rt.id AND rm.property_id=rt.property_id AND rm.active AND rm.housekeeping_status<>'OUT_OF_SERVICE'
      WHERE rt.property_id=pms_current_property_id() AND rt.active
      GROUP BY rt.id ORDER BY rt.code`),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=?").bind(arrival, departure),
    db.prepare("SELECT room_type_id,stay_date,COUNT(*) count FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<? GROUP BY room_type_id,stay_date").bind(arrival, departure),
    db.prepare(`SELECT bi.room_type_id,bi.stay_date,COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count
      FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id
      WHERE bi.property_id=pms_current_property_id() AND bi.stay_date>=? AND bi.stay_date<? AND bb.deduct_inventory AND bb.status IN ('TENTATIVE','DEFINITE')
      GROUP BY bi.room_type_id,bi.stay_date`).bind(arrival, departure),
    db.prepare("SELECT * FROM rate_plans WHERE property_id=pms_current_property_id() AND active ORDER BY code"),
    db.prepare("SELECT * FROM rate_plan_room_types WHERE property_id=pms_current_property_id() AND active"),
    db.prepare("SELECT * FROM rate_plan_calendar WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=?").bind(arrival, departure),
  ]);
  const hotel = property.results[0];
  if (!hotel) throw new PmsReadError("호텔 영업 정보를 찾을 수 없습니다.", 503);
  if (arrival < String(hotel.business_date)) throw new PmsReadError("호텔 영업일보다 이전 날짜는 선택할 수 없습니다.");
  const controlMap = new Map(controls.results.map((row) => [`${row.room_type_id}:${row.stay_date}`, row]));
  const soldMap = new Map(sold.results.map((row) => [`${row.room_type_id}:${row.stay_date}`, Number(row.count)]));
  const heldMap = new Map(held.results.map((row) => [`${row.room_type_id}:${row.stay_date}`, Number(row.count)]));
  const roomPlanMap = new Map(roomPlans.results.map((row) => [`${row.room_type_id}:${row.rate_plan_id}`, row]));
  const calendarMap = new Map(planCalendar.results.map((row) => [`${row.room_type_id}:${row.rate_plan_id}:${row.stay_date}`, row]));
  const offers = types.results.flatMap((type) => {
    if (adults + children > Number(type.capacity) || Number(type.physical) < 1) return [];
    const availability = dates.map((date) => {
      const control = controlMap.get(`${type.id}:${date}`);
      const limit = control?.sell_limit == null ? Number(type.physical) : Math.min(Number(type.physical), Number(control.sell_limit));
      return Math.max(0, limit - (soldMap.get(`${type.id}:${date}`) || 0) - (heldMap.get(`${type.id}:${date}`) || 0));
    });
    const arrivalControl = controlMap.get(`${type.id}:${arrival}`);
    const departureControl = controlMap.get(`${type.id}:${departure}`);
    const globallyClosed = dates.some((date) => {
      const control = controlMap.get(`${type.id}:${date}`);
      return Boolean(control?.closed) || availability[dates.indexOf(date)] < 1;
    }) || Boolean(arrivalControl?.close_to_arrival) || Boolean(departureControl?.close_to_departure);
    if (globallyClosed) return [];
    const typePlans = plans.results.flatMap((plan) => {
      if ((plan.valid_from && arrival < String(plan.valid_from)) || (plan.valid_to && departure > String(plan.valid_to))) return [];
      if (dates.length < Number(plan.min_stay || 1) || dates.length > Number(plan.max_stay || 365)) return [];
      const relation = roomPlanMap.get(`${type.id}:${plan.id}`);
      if (!relation || relation.active === false) return [];
      let closed = Boolean(calendarMap.get(`${type.id}:${plan.id}:${arrival}`)?.close_to_arrival)
        || Boolean(calendarMap.get(`${type.id}:${plan.id}:${departure}`)?.close_to_departure);
      const nights = dates.map((date) => {
        const calendar = calendarMap.get(`${type.id}:${plan.id}:${date}`);
        if (calendar?.closed || dates.length < Number(calendar?.min_stay || 1)) closed = true;
        if (date === arrival && calendar?.close_to_arrival) closed = true;
        const base = calculatedPlanRate(Number(type.base_rate), plan, relation?.base_rate);
        return { date, rate: Number(calendar?.sell_rate ?? base), available: availability[dates.indexOf(date)] };
      });
      if (closed) return [];
      const total = nights.reduce((sum, night) => sum + night.rate, 0);
      return [{
        id: String(plan.id), code: String(plan.code), name: String(plan.name),
        cancellationPolicy: String(plan.cancellation_policy || "정책 없음"),
        mealPlan: String(plan.meal_plan || "ROOM_ONLY"),
        guaranteePolicy: String(plan.guarantee_policy || ""),
        total, average: Math.round(total / nights.length), nights,
      }];
    });
    if (!typePlans.length) return [];
    return [{
      roomTypeId: String(type.id), code: String(type.code), name: String(type.name),
      capacity: Number(type.capacity), available: Math.min(...availability), plans: typePlans,
    }];
  });
  return {
    property: { name: hotel.name, currency: hotel.currency, businessDate: hotel.business_date },
    search: { arrival, departure, adults, children, nights: dates.length },
    offers,
  };
}
