/** Bounded read models for the operational search, front desk, and booking flow. */

import type { PmsDatabase } from "../../../db/pms-database";
import type { Principal } from "./auth";
import { canViewWorkspace } from "../../access-control";
import { addIsoDays } from "../../../lib/format";

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

type RoomBoardReservation=Record<string,unknown>&{
  id:string;arrival_date:string;departure_date:string;room_type_id:string;version:number;
};
type RoomBoardNight=RoomBoardReservation&{assignment_room_id:string;stay_date:string};

function boardRange(params:URLSearchParams){
  const from=params.get("from")||"",to=params.get("to")||"";
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(from)||!/^\d{4}-\d{2}-\d{2}$/u.test(to))
    throw new PmsReadError("룸 배정 보드의 시작일과 종료일이 필요합니다.");
  const start=new Date(`${from}T00:00:00Z`),end=new Date(`${to}T00:00:00Z`);
  const days=Math.round((end.valueOf()-start.valueOf())/86_400_000);
  if(!Number.isFinite(days)||days<1||days>31)
    throw new PmsReadError("룸 배정 보드는 1일부터 최대 31일까지 조회할 수 있습니다.");
  return {from,to,days,dates:Array.from({length:days},(_,index)=>addIsoDays(from,index))};
}

function boardReservation(row:RoomBoardReservation){
  return {
    id:String(row.id),confirmation_no:String(row.confirmation_no),first_name:String(row.first_name),last_name:String(row.last_name),
    vip_level:String(row.vip_level||"NONE"),room_number:row.room_number==null?null:String(row.room_number),room_id:row.room_id==null?null:String(row.room_id),
    room_type_id:String(row.room_type_id),room_type_code:String(row.room_type_code),room_type_name:String(row.room_type_name),
    arrival_date:String(row.arrival_date),departure_date:String(row.departure_date),status:String(row.status),adults:Number(row.adults),children:Number(row.children),
    source:String(row.source),rate_plan:String(row.rate_plan),nightly_rate:Number(row.nightly_rate),eta:row.eta==null?null:String(row.eta),notes:String(row.notes||""),
    balance:Number(row.balance||0),version:Number(row.version),
  };
}

/**
 * Bounded room/night projection for the physical assignment board. All source
 * rows are fetched in one transaction batch and continuous spans are grouped in
 * memory, avoiding one query per room or date while preserving move segments.
 */
export async function loadRoomBoard(db:PmsDatabase,params:URLSearchParams,principal:Principal){
  const range=boardRange(params);
  const reservationProjection=`r.id,r.confirmation_no,r.room_id,r.room_type_id,r.arrival_date,r.departure_date,r.status,r.adults,r.children,r.source,r.rate_plan,r.nightly_rate,r.eta,r.notes,r.version,
    g.first_name,g.last_name,g.vip_level,rt.code room_type_code,rt.name room_type_name,rm.number room_number,
    COALESCE((SELECT SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END) FROM folio_entries f WHERE f.property_id=r.property_id AND f.reservation_id=r.id),0) balance`;
  const [propertyResult,roomResult,nightResult,unassignedResult]=await db.batch([
    db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id() LIMIT 1"),
    db.prepare(`SELECT rm.id,rm.number,rm.floor,rm.room_type_id,rt.code room_type_code,rt.name room_type_name,
      rm.front_desk_status,rm.housekeeping_status,rm.version
      FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id AND rt.property_id=rm.property_id
      WHERE rm.property_id=pms_current_property_id() AND rm.active ORDER BY rm.floor,rm.number`),
    db.prepare(`SELECT rn.room_id assignment_room_id,rn.stay_date,${reservationProjection}
      FROM reservation_nights rn
      JOIN reservations r ON r.id=rn.reservation_id AND r.property_id=rn.property_id
      JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
      LEFT JOIN rooms rm ON rm.id=rn.room_id AND rm.property_id=rn.property_id
      WHERE rn.property_id=pms_current_property_id() AND rn.stay_date>=? AND rn.stay_date<?
      ORDER BY rn.room_id,rn.reservation_id,rn.stay_date`).bind(range.from,range.to),
    db.prepare(`SELECT ${reservationProjection}
      FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
      LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id
      WHERE r.property_id=pms_current_property_id() AND r.room_id IS NULL
        AND r.status NOT IN ('CANCELLED','NO_SHOW','CHECKED_OUT') AND r.arrival_date<? AND r.departure_date>?
      ORDER BY r.arrival_date,r.confirmation_no`).bind(range.to,range.from),
  ]);
  const maskedNights=maskReservationRows(nightResult.results,principal) as RoomBoardNight[];
  const spans:Array<{id:string;roomId:string;startDate:string;endDate:string;dates:string[];reservation:ReturnType<typeof boardReservation>}>=[];
  for(const row of maskedNights){
    const previous=spans.at(-1),date=String(row.stay_date),reservation=boardReservation(row);
    if(previous&&previous.roomId===String(row.assignment_room_id)&&previous.reservation.id===reservation.id&&previous.endDate===date){
      previous.dates.push(date);previous.endDate=addIsoDays(date,1);
    }else spans.push({id:`${row.assignment_room_id}:${reservation.id}:${date}`,roomId:String(row.assignment_room_id),startDate:date,endDate:addIsoDays(date,1),dates:[date],reservation});
  }
  const unassigned=maskReservationRows(unassignedResult.results,principal).map(row=>boardReservation(row as RoomBoardReservation));
  const businessDate=String((propertyResult.results[0] as {business_date?:string})?.business_date||range.from);
  const reservations=new Map<string,ReturnType<typeof boardReservation>>();
  for(const span of spans)reservations.set(span.reservation.id,span.reservation);
  for(const row of unassigned)reservations.set(row.id,row);
  const values=[...reservations.values()];
  return {
    ...range,businessDate,rooms:roomResult.results,spans,unassigned,
    summary:{
      arrivals:values.filter(row=>row.arrival_date===businessDate&&row.status==="DUE_IN").length,
      inHouse:values.filter(row=>row.status==="IN_HOUSE").length,
      departures:values.filter(row=>row.departure_date===businessDate&&row.status==="IN_HOUSE").length,
      unassigned:unassigned.length,
      sellable:roomResult.results.filter(row=>row.housekeeping_status!=="OUT_OF_SERVICE").length,
    },
  };
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

type ReservationLogCategory = "integration" | "edits" | "rates" | "blocks";

function reservationLogCategory(action: unknown, entityType: unknown): ReservationLogCategory {
  const value = `${String(action || "")} ${String(entityType || "")}`.toUpperCase();
  if (/(CHANNEL|INBOUND|OUTBOUND|OUTBOX|ARI|INTEGRATION)/u.test(value)) return "integration";
  if (/(RATE|PRICE|INVENTORY|FOLIO|PAYMENT|REFUND)/u.test(value)) return "rates";
  if (/(BLOCK|GROUP|ROOMING|PICKUP)/u.test(value)) return "blocks";
  return "edits";
}

/**
 * Reservation detail is intentionally separate from the list projection. It
 * loads only one reservation and its bounded history when the operator opens
 * the drawer, keeping the everyday front-desk queue small.
 */
export async function loadReservationDetail(
  db: PmsDatabase,
  reservationId: string,
  principal: Principal,
) {
  const id = reservationId.trim().slice(0, 80);
  if (!id) throw new PmsReadError("예약 식별자가 필요합니다.");
  const [detailResult, nightResult, logResult, linkResult] = await db.batch([
    db.prepare(`SELECT r.*,p.name property_name,p.code property_code,p.currency,
        g.first_name,g.last_name,g.email guest_email,g.phone guest_phone,g.nationality,g.vip_level,
        rt.code room_type_code,rt.name room_type_name,rm.number room_number,
        rp.code product_code,rp.name product_name,rp.meal_plan,rp.package_type,
        COALESCE(r.rate_plan_snapshot->'inclusions','[]'::jsonb) inclusions,
        COALESCE(r.rate_plan_snapshot->'cancellationTerms',rp.cancellation_terms,'[]'::jsonb) cancellation_terms,
        COALESCE(r.rate_plan_snapshot->>'cancellationPolicy',rp.cancellation_policy,'정책 없음') cancellation_policy
      FROM reservations r
      JOIN properties p ON p.id=r.property_id
      JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
      LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id
      LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id AND rp.property_id=r.property_id
      WHERE r.property_id=pms_current_property_id() AND r.id=? LIMIT 1`).bind(id),
    db.prepare(`SELECT stay_date,sell_rate,currency,rate_plan,created_at
      FROM reservation_rate_nights
      WHERE property_id=pms_current_property_id() AND reservation_id=?
      ORDER BY stay_date`).bind(id),
    db.prepare(`WITH related_entities AS (
        SELECT id FROM rooming_list_entries
         WHERE property_id=pms_current_property_id() AND reservation_id=?
        UNION
        SELECT block_id FROM rooming_list_entries
         WHERE property_id=pms_current_property_id() AND reservation_id=?
      )
      SELECT id,actor,action,entity_type,entity_id,before_json,after_json,created_at
      FROM audit_logs
      WHERE property_id=pms_current_property_id()
        AND (entity_id=? OR entity_id IN (SELECT id FROM related_entities))
      ORDER BY created_at DESC LIMIT 200`).bind(id, id, id),
    db.prepare(`SELECT l.id,l.relation_type,l.notes,l.created_at,
        other.id reservation_id,other.confirmation_no,other.arrival_date,other.departure_date,other.status,
        g.first_name,g.last_name
      FROM reservation_links l
      JOIN reservations other ON other.property_id=l.property_id
       AND other.id=CASE WHEN l.reservation_id=? THEN l.linked_reservation_id ELSE l.reservation_id END
      JOIN guests g ON g.property_id=other.property_id AND g.id=other.guest_id
      WHERE l.property_id=pms_current_property_id()
        AND (l.reservation_id=? OR l.linked_reservation_id=?)
      ORDER BY l.created_at DESC LIMIT 50`).bind(id, id, id),
  ]);
  const detail = detailResult.results[0];
  if (!detail) throw new PmsReadError("예약을 찾지 못했습니다.", 404);
  const masked = principal.piiMode === "MASKED"
    ? {
        ...detail,
        booker_name: `${String(detail.booker_name || "").slice(0, 1)}**`,
        booker_phone: "***-****-****",
        booker_email: "masked@support.invalid",
        first_name: `${String(detail.first_name || "").slice(0, 1)}**`,
        last_name: `${String(detail.last_name || "").slice(0, 1)}**`,
        guest_phone: "***-****-****",
        guest_email: "masked@support.invalid",
        guest_request: "지원 조회에서 마스킹됨",
        guest_request_response: "지원 조회에서 마스킹됨",
        manager_memo: "지원 조회에서 마스킹됨",
        hotel_memo: "지원 조회에서 마스킹됨",
        card_info_ref: null,
      }
    : detail;
  const logs = { integration: [], edits: [], rates: [], blocks: [] } as Record<ReservationLogCategory, Array<Record<string, unknown>>>;
  for (const row of logResult.results) {
    const safe = principal.piiMode === "MASKED" ? { ...row, before_json: null, after_json: null } : row;
    logs[reservationLogCategory(row.action, row.entity_type)].push(safe);
  }
  return {
    reservation: masked,
    rateNights: nightResult.results,
    links: principal.piiMode === "MASKED"
      ? linkResult.results.map((row) => ({ ...row, first_name: `${String(row.first_name || "").slice(0, 1)}**`, last_name: `${String(row.last_name || "").slice(0, 1)}**` }))
      : linkResult.results,
    logs,
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

type ReservationFactRow = Record<string, unknown>;

/** One bounded batch feeds both HotelStory-style List and Calendar booking views. */
async function loadReservationFacts(db:PmsDatabase,from:string,to:string) {
  const [property,types,controls,sold,held,plans,roomPlans,planCalendar,occupancy]=await db.batch([
    db.prepare("SELECT name,currency,business_date FROM properties WHERE id=pms_current_property_id() LIMIT 1"),
    db.prepare(`SELECT rt.id,rt.code,rt.name,rt.base_rate,rt.capacity,COUNT(rm.id) physical
      FROM room_types rt LEFT JOIN rooms rm ON rm.room_type_id=rt.id AND rm.property_id=rt.property_id AND rm.active AND rm.housekeeping_status<>'OUT_OF_SERVICE'
      WHERE rt.property_id=pms_current_property_id() AND rt.active
      GROUP BY rt.id ORDER BY rt.code`),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=?").bind(from,to),
    db.prepare("SELECT room_type_id,stay_date,COUNT(*) count FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=? GROUP BY room_type_id,stay_date").bind(from,to),
    db.prepare(`SELECT bi.room_type_id,bi.stay_date,COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count
      FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id
      WHERE bi.property_id=pms_current_property_id() AND bi.stay_date>=? AND bi.stay_date<=? AND bb.deduct_inventory AND bb.status IN ('TENTATIVE','DEFINITE')
      GROUP BY bi.room_type_id,bi.stay_date`).bind(from,to),
    db.prepare("SELECT * FROM rate_plans WHERE property_id=pms_current_property_id() AND active ORDER BY sort_order,code"),
    db.prepare("SELECT * FROM rate_plan_room_types WHERE property_id=pms_current_property_id() AND active"),
    db.prepare("SELECT * FROM rate_plan_calendar WHERE property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=?").bind(from,to),
    db.prepare("SELECT * FROM rate_plan_occupancy WHERE property_id=pms_current_property_id()"),
  ]);
  const hotel=property.results[0];
  if(!hotel)throw new PmsReadError("호텔 영업 정보를 찾을 수 없습니다.",503);
  return {
    hotel,types:types.results,plans:plans.results,
    controlMap:new Map(controls.results.map(row=>[`${row.room_type_id}:${row.stay_date}`,row])),
    soldMap:new Map(sold.results.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.count)])),
    heldMap:new Map(held.results.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.count)])),
    roomPlanMap:new Map(roomPlans.results.map(row=>[`${row.room_type_id}:${row.rate_plan_id}`,row])),
    calendarMap:new Map(planCalendar.results.map(row=>[`${row.room_type_id}:${row.rate_plan_id}:${row.stay_date}`,row])),
    occupancyMap:new Map(occupancy.results.map(row=>[`${row.rate_plan_id}:${row.occupancy}`,Number(row.extra_charge)])),
    planMap:new Map(plans.results.map(row=>[String(row.id),row])),
  };
}

function availableRooms(facts:Awaited<ReturnType<typeof loadReservationFacts>>,type:ReservationFactRow,date:string) {
  const control=facts.controlMap.get(`${type.id}:${date}`) as ReservationFactRow|undefined;
  const physical=Number(type.physical),limit=control?.sell_limit==null?physical:Math.min(physical,Number(control.sell_limit));
  return Math.max(0,limit-(facts.soldMap.get(`${type.id}:${date}`)||0)-(facts.heldMap.get(`${type.id}:${date}`)||0));
}

/** Mirrors talos_effective_product_rate without adding one database round trip per cell. */
function productNightRate(facts:Awaited<ReturnType<typeof loadReservationFacts>>,type:ReservationFactRow,plan:ReservationFactRow,date:string,partySize:number) {
  if(partySize<1||partySize>Number(plan.max_occupancy||20))return null;
  const relation=facts.roomPlanMap.get(`${type.id}:${plan.id}`) as ReservationFactRow|undefined;
  if(!relation||relation.active===false)return null;
  const calendar=facts.calendarMap.get(`${type.id}:${plan.id}:${date}`) as ReservationFactRow|undefined;
  const openCalendar=calendar&&!calendar.closed?calendar:undefined;
  let base=openCalendar?.sell_rate==null?Number(relation.base_rate):Number(openCalendar.sell_rate);
  if(openCalendar?.sell_rate==null&&plan.parent_rate_plan_id&&["OFFSET","PERCENT"].includes(String(plan.pricing_model))){
    const parent=facts.planMap.get(String(plan.parent_rate_plan_id)) as ReservationFactRow|undefined;
    const parentRelation=facts.roomPlanMap.get(`${type.id}:${plan.parent_rate_plan_id}`) as ReservationFactRow|undefined;
    const parentCalendar=facts.calendarMap.get(`${type.id}:${plan.parent_rate_plan_id}:${date}`) as ReservationFactRow|undefined;
    if(!parent||!parentRelation)return null;
    const parentBase=Number((parentCalendar&&!parentCalendar.closed?parentCalendar.sell_rate:null)??parentRelation.base_rate),adjustment=Number(plan.adjustment||0);
    base=plan.pricing_model==="OFFSET"?parentBase+adjustment:parentBase*(1+adjustment/100);
  }
  if(!Number.isFinite(base))return null;
  return Math.round(Math.max(0,base+(facts.occupancyMap.get(`${plan.id}:${partySize}`)||0))*100)/100;
}

function productAvailableNow(plan:ReservationFactRow,now=Date.now()) {
  return !(plan.sellable_from&&now<Date.parse(String(plan.sellable_from)))&&!(plan.sellable_to&&now>Date.parse(String(plan.sellable_to)));
}

function productProjection(plan:ReservationFactRow) {
  return {
    id:String(plan.id),code:String(plan.code),name:String(plan.name),description:String(plan.description||""),
    cancellationPolicy:String(plan.cancellation_policy||"정책 없음"),mealPlan:String(plan.meal_plan||"ROOM_ONLY"),
    guaranteePolicy:String(plan.guarantee_policy||""),packageType:String(plan.package_type||"NONE"),
    inclusions:Array.isArray(plan.inclusions)?plan.inclusions.map(String):[],
    baseOccupancy:Number(plan.base_occupancy||1),maxOccupancy:Number(plan.max_occupancy||20),
  };
}

/** Authoritative staff List availability projection used before reservation commit. */
export async function loadReservationAvailability(db:PmsDatabase,params:URLSearchParams) {
  const arrival=params.get("arrival")||"",departure=params.get("departure")||"";
  const adults=Math.max(1,Math.min(20,Number(params.get("adults"))||1)),children=Math.max(0,Math.min(12,Number(params.get("children"))||0)),partySize=adults+children;
  const dates=stayDates(arrival,departure);
  if(!dates.length)throw new PmsReadError("올바른 체크인·체크아웃 날짜를 입력하세요. 최대 30박까지 조회할 수 있습니다.");
  const facts=await loadReservationFacts(db,arrival,departure);
  if(arrival<String(facts.hotel.business_date))throw new PmsReadError("호텔 영업일보다 이전 날짜는 선택할 수 없습니다.");
  const offers=facts.types.flatMap(type=>{
    if(partySize>Number(type.capacity)||Number(type.physical)<1)return [];
    const availability=dates.map(date=>availableRooms(facts,type,date));
    const arrivalControl=facts.controlMap.get(`${type.id}:${arrival}`) as ReservationFactRow|undefined;
    const departureControl=facts.controlMap.get(`${type.id}:${departure}`) as ReservationFactRow|undefined;
    if(dates.some((date,index)=>Boolean((facts.controlMap.get(`${type.id}:${date}`) as ReservationFactRow|undefined)?.closed)||availability[index]<1)||arrivalControl?.close_to_arrival||departureControl?.close_to_departure)return [];
    const typePlans=facts.plans.flatMap(plan=>{
      const lastStay=dates[dates.length-1];
      if(!productAvailableNow(plan)||(plan.valid_from&&arrival<String(plan.valid_from))||(plan.valid_to&&lastStay>String(plan.valid_to))||partySize>Number(plan.max_occupancy||20))return [];
      if(dates.length<Number(plan.min_stay||1)||dates.length>Number(plan.max_stay||365))return [];
      let closed=false;
      const nights=dates.map((date,index)=>{
        const calendar=facts.calendarMap.get(`${type.id}:${plan.id}:${date}`) as ReservationFactRow|undefined;
        if(calendar?.closed||dates.length<Number(calendar?.min_stay||1)||(date===arrival&&calendar?.close_to_arrival))closed=true;
        const rate=productNightRate(facts,type,plan,date,partySize);
        if(rate==null)closed=true;
        return {date,rate:Number(rate||0),available:availability[index]};
      });
      if(closed)return [];
      const total=nights.reduce((sum,night)=>sum+night.rate,0);
      return [{...productProjection(plan),total,average:Math.round(total/nights.length),nights}];
    });
    return typePlans.length?[{roomTypeId:String(type.id),code:String(type.code),name:String(type.name),capacity:Number(type.capacity),available:Math.min(...availability),plans:typePlans}]:[];
  });
  return {property:{name:facts.hotel.name,currency:facts.hotel.currency,businessDate:facts.hotel.business_date},search:{arrival,departure,adults,children,nights:dates.length},offers};
}

function monthDates(month:string) {
  if(!/^\d{4}-\d{2}$/u.test(month))return [];
  const start=new Date(`${month}-01T00:00:00Z`);
  if(!Number.isFinite(start.valueOf())||start.toISOString().slice(0,7)!==month)return [];
  const output:string[]=[];
  for(const cursor=new Date(start);cursor.toISOString().slice(0,7)===month&&output.length<31;cursor.setUTCDate(cursor.getUTCDate()+1))output.push(cursor.toISOString().slice(0,10));
  return output;
}

/** Month product calendar; one selected product keeps payload and DOM bounded. */
export async function loadReservationCalendar(db:PmsDatabase,params:URLSearchParams) {
  const month=params.get("month")||"",dates=monthDates(month);
  if(!dates.length)throw new PmsReadError("조회할 달을 확인하세요.");
  const adults=Math.max(1,Math.min(20,Number(params.get("adults"))||1)),children=Math.max(0,Math.min(12,Number(params.get("children"))||0)),partySize=adults+children;
  const facts=await loadReservationFacts(db,dates[0],dates[dates.length-1]);
  const products=facts.plans.filter(productAvailableNow).map(productProjection);
  const requested=params.get("ratePlanId")||"",selected=facts.plans.find(plan=>String(plan.id)===requested&&productAvailableNow(plan))||facts.plans.find(productAvailableNow)||null;
  const rows=selected?facts.types.map(type=>({
    roomTypeId:String(type.id),code:String(type.code),name:String(type.name),capacity:Number(type.capacity),physical:Number(type.physical),
    cells:dates.map(date=>{
      const control=facts.controlMap.get(`${type.id}:${date}`) as ReservationFactRow|undefined;
      const calendar=facts.calendarMap.get(`${type.id}:${selected.id}:${date}`) as ReservationFactRow|undefined;
      const available=availableRooms(facts,type,date),rate=productNightRate(facts,type,selected,date,partySize);
      const valid=(!selected.valid_from||date>=String(selected.valid_from))&&(!selected.valid_to||date<=String(selected.valid_to));
      return {date,available,total:Number(type.physical),rate,closed:date<String(facts.hotel.business_date)||partySize>Number(type.capacity)||!valid||Boolean(control?.closed)||Boolean(calendar?.closed)||available<1||rate==null};
    }),
  })):[];
  return {property:{name:facts.hotel.name,currency:facts.hotel.currency,businessDate:facts.hotel.business_date},month,dates,adults,children,products,selectedProduct:selected?productProjection(selected):null,rows};
}
