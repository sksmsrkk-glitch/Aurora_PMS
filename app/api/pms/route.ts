import { getPmsDatabase, scopePmsDatabase, type PmsDatabase, type PmsPreparedStatement, type PmsRuntimeBindings } from "../../../db/pms-database";
import { authenticateSupabaseRequest } from "../../supabase-session";
import { consumeRateLimit, rateLimitHeaders } from "../rate-limit";
import { ReportRequestError, runReport } from "./reporting";
import { timingSafeEqual } from "node:crypto";
/** Authenticated PMS API router and transactional command gateway. */
import { handleExtendedAction, loadAccountingCenter, loadInventoryCalendar, loadWebsiteAdmin, PmsExtendedError } from "./extended";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type D1 = PmsDatabase;
type D1PreparedStatement = PmsPreparedStatement;
type Role = "PROPERTY_ADMIN" | "NIGHT_AUDITOR" | "FRONT_DESK" | "CASHIER" | "HOUSEKEEPING" | "REVENUE_MANAGER" | "SALES_MANAGER" | "ACCOUNTANT" | "VIEWER";
type Principal = { email: string; displayName: string; role: Role; capabilities: string[]; propertyId: string };

const runtimeBindings:PmsRuntimeBindings={
  DATABASE_URL:process.env.DATABASE_URL,
};

const roleCapabilities: Record<Role, string[]> = {
  PROPERTY_ADMIN: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "AR_WRITE", "HOUSEKEEPING_WRITE", "CASHIER_WRITE", "EOD_RUN", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT", "ADMIN"],
  NIGHT_AUDITOR: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "EOD_RUN", "REPORT_EXPORT"],
  FRONT_DESK: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  CASHIER: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "REPORT_EXPORT"],
  HOUSEKEEPING: ["READ", "HOUSEKEEPING_WRITE"],
  REVENUE_MANAGER: ["READ", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "REPORT_EXPORT"],
  SALES_MANAGER: ["READ", "RESERVATION_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  ACCOUNTANT: ["READ", "FOLIO_WRITE", "AR_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT"],
  VIEWER: ["READ"],
};

const actionCapability: Record<string, string> = {
  create_reservation: "RESERVATION_WRITE", mark_no_show: "STAY_WRITE", check_in: "STAY_WRITE", check_out: "STAY_WRITE",
  edit_reservation: "RESERVATION_WRITE", cancel_reservation: "RESERVATION_WRITE", assign_room: "RESERVATION_WRITE", move_room: "STAY_WRITE",
  update_inventory_control: "INVENTORY_WRITE", bulk_update_inventory_controls: "INVENTORY_WRITE",
  create_account_profile: "GROUP_WRITE", create_business_block: "GROUP_WRITE", update_block_inventory: "GROUP_WRITE", add_rooming_entry: "GROUP_WRITE", cutoff_block: "GROUP_WRITE",
  pickup_rooming_entry: "GROUP_PICKUP",
  post_payment: "FOLIO_WRITE", post_charge: "FOLIO_WRITE", create_folio_window: "FOLIO_WRITE", create_routing_rule: "FOLIO_WRITE", split_folio_entry: "FOLIO_WRITE", reverse_folio_entry: "FOLIO_WRITE", refund_payment: "FOLIO_WRITE",
  transfer_to_ar: "AR_WRITE", post_ar_payment: "AR_WRITE", housekeeping: "HOUSEKEEPING_WRITE",
  create_channel_connection: "INTEGRATION_WRITE", create_channel_mapping: "INTEGRATION_WRITE", upsert_channel_contract: "INTEGRATION_WRITE", queue_ari_delta: "INTEGRATION_WRITE", dispatch_ari_update: "INTEGRATION_WRITE", ingest_channel_message: "INTEGRATION_WRITE", replay_channel_message: "INTEGRATION_WRITE", dispatch_outbox_event: "INTEGRATION_WRITE",
  post_accounting_entry: "ACCOUNTING_WRITE", reverse_accounting_entry: "ACCOUNTING_WRITE", accrue_channel_settlement: "ACCOUNTING_WRITE", mark_channel_settlement_paid: "ACCOUNTING_WRITE",
  open_cashier: "CASHIER_WRITE", close_cashier: "CASHIER_WRITE", run_night_audit: "EOD_RUN",
  create_room_type: "ADMIN", update_room_type: "ADMIN", create_room: "ADMIN", update_room: "ADMIN", bulk_create_rooms: "ADMIN", export_report: "REPORT_EXPORT",
  update_website_settings: "ADMIN", update_room_type_website: "ADMIN", upload_website_media: "ADMIN", delete_website_media: "ADMIN",
};

let readiness: Promise<void> | null = null;

/**
 * Runtime startup is deliberately read-only. PostgreSQL schema and seed changes
 * are applied only through versioned files in supabase/migrations and seed.sql.
 */
async function ready(db: D1) {
  if (!readiness) {
    readiness = verifyMigratedSchema(db).catch((error) => {
      readiness = null;
      throw error;
    });
  }
  await readiness;
}

async function verifyMigratedSchema(db: D1) {
  const requiredTables = [
    "properties",
    "reservations",
    "reservation_type_nights",
    "reservation_rate_nights",
    "booking_requests",
    "api_rate_limits",
    "business_blocks",
    "folio_windows",
    "channel_connections",
    "report_exports",
    "channel_contracts",
    "accounting_accounts",
    "accounting_journal_entries",
    "website_settings",
    "room_type_website",
    "website_media",
  ];
  const rows = await db
    .prepare(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY(?::text[])`,
    )
    .bind(requiredTables)
    .all<{ table_name: string }>();
  const found = new Set(rows.results.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !found.has(table));
  if (missing.length) {
    throw new Error(
      `Aurora PMS database is not migrated. Missing tables: ${missing.join(", ")}. Run npm run db:supabase:migrate.`,
    );
  }
}

function decodedDisplayName(request: Request, email: string) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded || request.headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return email;
  try { return decodeURIComponent(encoded); } catch { return email; }
}

const principalCache = new Map<string,{expires:number;role:Role;propertyId:string}>();
const principalInflight = new Map<string,Promise<{role:Role;propertyId:string}|null>>();

function demoAuthenticationEnabled(request: Request) {
  // Demo identity is deliberately impossible in production and requires both an
  // operator flag and a high-entropy request token. Host-derived values are never
  // authentication evidence because reverse proxies can rewrite them.
  if (process.env.NODE_ENV === "production" || process.env.PMS_ALLOW_DEMO_AUTH !== "true") return false;
  const expected = process.env.PMS_DEMO_AUTH_TOKEN || "";
  const supplied = request.headers.get("x-aurora-demo-token") || "";
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function principalFor(request: Request, db: D1): Promise<Principal | null> {
  // Authentication establishes identity; role_assignments establishes the property
  // scope. The requested property is accepted only when that same user has an active
  // assignment, preventing a client-controlled header from crossing tenant bounds.
  const identity = await authenticateSupabaseRequest(request);
  let email = identity?.email || null, displayName = identity?.displayName || "";
  if (!email && demoAuthenticationEnabled(request)) {
    email = process.env.PMS_DEMO_USER_EMAIL?.trim().toLowerCase() || null;
    displayName = email || "";
  }
  if (!email) return null;
  const requestedProperty = request.headers.get("x-aurora-property-id")?.trim() || null;
  const cacheKey = `${email}:${requestedProperty || "default"}`, cached=principalCache.get(cacheKey),now=Date.now();
  if(cached&&cached.expires>now)return {email,displayName:displayName||email,role:cached.role,capabilities:roleCapabilities[cached.role],propertyId:cached.propertyId};
  if(principalCache.size>500){for(const [key,item] of principalCache)if(item.expires<=now)principalCache.delete(key);if(principalCache.size>500)principalCache.clear();}
  let assignmentPromise=principalInflight.get(cacheKey);
  if(!assignmentPromise){
    assignmentPromise=db.prepare("SELECT property_id,role FROM role_assignments WHERE email=? AND active=1 ORDER BY created_at").bind(email).all<{property_id:string;role:Role}>().then((assignments)=>{
      const assignment=requestedProperty?assignments.results.find((item)=>item.property_id===requestedProperty):assignments.results[0];
      return assignment&&roleCapabilities[assignment.role]?{role:assignment.role,propertyId:assignment.property_id}:null;
    });
    principalInflight.set(cacheKey,assignmentPromise);
  }
  let assignment:{role:Role;propertyId:string}|null;
  try{assignment=await assignmentPromise;}finally{if(principalInflight.get(cacheKey)===assignmentPromise)principalInflight.delete(cacheKey);}
  if (!assignment) return null;
  const { role, propertyId } = assignment;
  principalCache.set(cacheKey,{expires:now+30_000,role,propertyId});
  return { email, displayName: displayName||decodedDisplayName(request, email), role, capabilities: roleCapabilities[role], propertyId };
}

async function operationalControls(db: D1, businessDate: string, actor?: string) {
  // Keep the close-day guard below the six-connection serverless pool ceiling.
  // Seven independent parallel queries could occupy every connection while a
  // queued guard waited behind them; one snapshot is faster and consistent.
  const summary=await db.prepare("SELECT (SELECT COUNT(*) FROM reservations WHERE property_id='prop-seoul' AND arrival_date=? AND status='DUE_IN') arrivals,(SELECT COUNT(*) FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=? AND status='OPEN') cashiers,(SELECT COUNT(*) FROM rooms WHERE property_id='prop-seoul' AND housekeeping_status='OUT_OF_SERVICE') oos,(SELECT COUNT(*) FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED') failed,(SELECT COUNT(*) FROM night_audits WHERE property_id='prop-seoul' AND business_date=?) prior_audits,(SELECT COUNT(*) FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')) room_postings").bind(businessDate,businessDate,businessDate,businessDate,businessDate,businessDate).first<{arrivals:number;cashiers:number;oos:number;failed:number;prior_audits:number;room_postings:number}>();
  const openCashier=actor?await db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first():null;
  const priorAudit=Number(summary?.prior_audits??0)>0?await db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=? LIMIT 1").bind(businessDate).first():null;
  const blockers = [
    { code:"UNRESOLVED_ARRIVALS", label:"미처리 도착 예약", count:Number(summary?.arrivals??0), blocking:true },
    { code:"OPEN_CASHIERS", label:"미마감 캐셔", count:Number(summary?.cashiers??0), blocking:true },
    { code:"FAILED_INTERFACES", label:"인터페이스 전송 실패", count:Number(summary?.failed??0), blocking:false },
    { code:"OUT_OF_SERVICE", label:"판매 중지 객실", count:Number(summary?.oos??0), blocking:false },
  ];
  return { blockers, canClose: blockers.every(x=>!x.blocking||x.count===0) && !priorAudit, openCashier, priorAudit, pendingRoomPostings:Number(summary?.room_postings??0) };
}

function datesBetween(arrival: string, departure: string) {
  const start = new Date(`${arrival}T00:00:00Z`), end = new Date(`${departure}T00:00:00Z`); const dates: string[] = [];
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) return dates;
  for (let day = new Date(start); day < end && dates.length < 730; day.setUTCDate(day.getUTCDate()+1)) dates.push(day.toISOString().slice(0,10));
  return dates;
}

const roundMoney=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
function inclusiveComponents(total:number,taxRate:number,serviceRate:number) {
  const net=roundMoney(total/(1+taxRate+serviceRate)); const tax=roundMoney(net*taxRate); const service=roundMoney(total-net-tax);
  return {net,tax,service,total:roundMoney(total)};
}
async function folioWindowFor(db:D1,reservationId:string,code:string,explicit?:string) {
  if(explicit){const row=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id='prop-seoul' AND status='OPEN'").bind(explicit,reservationId).first<{id:string}>();if(row)return row.id;throw new Error("invalid folio window");}
  const routed=await db.prepare("SELECT w.id FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id WHERE rr.reservation_id=? AND rr.transaction_code=? AND rr.property_id='prop-seoul' AND w.property_id='prop-seoul' AND rr.active=1 AND w.status='OPEN' LIMIT 1").bind(reservationId,code).first<{id:string}>(); if(routed)return routed.id;
  const base=await db.prepare("SELECT id FROM folio_windows WHERE reservation_id=? AND property_id='prop-seoul' AND status='OPEN' ORDER BY window_no LIMIT 1").bind(reservationId).first<{id:string}>(); if(!base)throw new Error("invalid folio window"); return base.id;
}

type ChannelPayload={connectionId:string;messageId:string;eventType:string;externalReservationId:string;revision:number;externalRoomTypeId?:string;externalRatePlanId?:string;firstName?:string;lastName?:string;email?:string;arrivalDate?:string;departureDate?:string;adults?:number;children?:number;nightlyRate?:number;currency?:string};
async function processChannelMessage(db:D1,message:Record<string,unknown>,payload:ChannelPayload,actor:string,now:string) {
  // Provider revisions must increase monotonically per external reservation. The
  // reservation mutation, inventory-night replacement, link revision, delivery
  // receipt, audit log, and outbox event commit together to make retries observable
  // without applying an old OTA message over newer hotel state.
  const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND property_id='prop-seoul' AND status='ACTIVE'").bind(payload.connectionId).first<Record<string,unknown>>();if(!connection)throw new Error("channel connection unavailable");
  const link=await db.prepare("SELECT * FROM channel_reservation_links WHERE connection_id=? AND external_reservation_id=? AND property_id='prop-seoul'").bind(payload.connectionId,payload.externalReservationId).first<Record<string,unknown>>();
  const revision=Number(payload.revision),attemptNo=Number(message.attempts??0)+1,eventType=payload.eventType.toUpperCase();if(!Number.isInteger(revision)||revision<1)throw new Error("invalid channel revision");if(link&&revision<=Number(link.last_revision))throw new Error("stale channel revision");
  const statements:D1PreparedStatement[]=[];let reservationId=String(link?.reservation_id??"");
  if(eventType==="NEW"){
    if(link)throw new Error("channel reservation already linked");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND property_id='prop-seoul' AND active=1").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping)throw new Error("channel mapping unavailable");
    if(!payload.firstName?.trim()||!payload.lastName?.trim()||!payload.arrivalDate||!payload.departureDate)throw new Error("invalid channel reservation");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);
    const guestId=crypto.randomUUID();reservationId=crypto.randomUUID();const confirmation=`OTA-${String(connection.provider).slice(0,3).toUpperCase()}-${Math.floor(100000+Math.random()*900000)}`,nightlyRate=Number(payload.nightlyRate);if(!(nightlyRate>=0))throw new Error("invalid channel reservation");
    statements.push(db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, NULL, 'NONE', NULL, '[]', ?)").bind(guestId,payload.firstName.trim(),payload.lastName.trim(),payload.email||null,now));
    statements.push(db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||1,Number(payload.children)||0,String(connection.provider),String(mapping.rate_plan),nightlyRate,`Channel ${payload.externalReservationId} · revision ${revision}`,now,now));
    statements.push(db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("INSERT INTO channel_reservation_links VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'ACTIVE', ?, ?)").bind(crypto.randomUUID(),payload.connectionId,payload.externalReservationId,reservationId,revision,now,now));
  } else if(eventType==="MODIFY"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN'").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be modified");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND property_id='prop-seoul' AND active=1").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping||!payload.arrivalDate||!payload.departureDate)throw new Error("channel mapping unavailable");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);reservationId=String(link.reservation_id);
    statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'CHANNEL_MODIFY', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservationId));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("UPDATE reservations SET room_type_id=?,room_id=NULL,arrival_date=?,departure_date=?,adults=?,children=?,nightly_rate=?,notes=?,version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND version=?").bind(mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||Number(reservation.adults),Number(payload.children)||0,Number(payload.nightlyRate)||Number(reservation.nightly_rate),`Channel ${payload.externalReservationId} · revision ${revision}`,now,reservationId,Number(reservation.version)));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,updated_at=? WHERE id=? AND property_id='prop-seoul'").bind(revision,now,link.id));
  } else if(eventType==="CANCEL"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id='prop-seoul' AND status NOT IN ('CANCELLED','CHECKED_OUT')").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be cancelled");reservationId=String(link.reservation_id);statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'CHANNEL_CANCEL', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("UPDATE reservations SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND version=?").bind(now,reservationId,Number(reservation.version)));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservationId));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,status='CANCELLED',updated_at=? WHERE id=? AND property_id='prop-seoul'").bind(revision,now,link.id));
  } else throw new Error("unsupported channel event");
  statements.push(db.prepare("UPDATE inbound_channel_messages SET status='PROCESSED',attempts=?,reservation_id=?,last_error=NULL,processed_at=? WHERE id=? AND property_id='prop-seoul'").bind(attemptNo,reservationId,now,message.id));statements.push(db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, ?, 'ACKED', 200, NULL, NULL, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,message.id,attemptNo,JSON.stringify(payload),now,actor));statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, ?, 'channel_reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,`CHANNEL_${eventType}`,reservationId,JSON.stringify({externalReservationId:payload.externalReservationId,revision,messageId:payload.messageId}),now));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', ?, 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),`channel.reservation_${eventType.toLowerCase()}`,reservationId,JSON.stringify({reservationId,externalReservationId:payload.externalReservationId,revision}),now));await db.batch(statements);return reservationId;
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
  // The full snapshot is the compatibility contract for domain-heavy screens. It
  // favors one batched round trip and a mutually consistent read model over many
  // client requests that could observe different points in time.
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult,accountProfilesResult,blocksResult,blockInventoryResult,roomingResult,folioWindowsResult,folioEntriesResult,routingRulesResult,transactionCodesResult,arAccountsResult,arInvoicesResult,trialBalanceResult,channelConnectionsResult,channelContractsResult,channelMappingsResult,ariUpdatesResult,inboundMessagesResult,channelLinksResult,integrationAttemptsResult,outboxResult] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id='prop-seoul' GROUP BY r.id,g.id,rt.id,rm.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
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
    db.prepare("SELECT bb.*,ap.name account_name,gp.name group_name,COALESCE(SUM(bi.original_rooms),0) original_room_nights,COALESCE(SUM(bi.current_rooms),0) current_room_nights,COALESCE(SUM(bi.picked_up),0) picked_up_room_nights FROM business_blocks bb LEFT JOIN account_profiles ap ON ap.id=bb.account_profile_id LEFT JOIN account_profiles gp ON gp.id=bb.group_profile_id LEFT JOIN block_inventory bi ON bi.block_id=bb.id WHERE bb.property_id='prop-seoul' GROUP BY bb.id,ap.id,gp.id ORDER BY bb.arrival_date,bb.code"),
    db.prepare("SELECT bi.*,rt.code room_type_code,rt.name room_type_name FROM block_inventory bi JOIN room_types rt ON rt.id=bi.room_type_id WHERE bi.property_id='prop-seoul' ORDER BY bi.block_id,bi.stay_date,rt.code"),
    db.prepare("SELECT rl.*,rt.code room_type_code,rt.name room_type_name FROM rooming_list_entries rl JOIN room_types rt ON rt.id=rl.room_type_id WHERE rl.property_id='prop-seoul' ORDER BY rl.block_id,rl.last_name,rl.first_name"),
    db.prepare(`SELECT w.*,g.first_name||' '||g.last_name guest_name,r.confirmation_no,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id LEFT JOIN folio_entries f ON f.id=d.entry_id WHERE w.property_id='prop-seoul' GROUP BY w.id,r.id,g.id ORDER BY r.updated_at DESC,w.window_no`),
    db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,d.currency,d.source_entry_id,d.reason,w.window_no,w.name window_name,r.confirmation_no,g.first_name||' '||g.last_name guest_name FROM folio_entries f LEFT JOIN folio_entry_details d ON d.entry_id=f.id LEFT JOIN folio_windows w ON w.id=d.folio_window_id JOIN reservations r ON r.id=f.reservation_id JOIN guests g ON g.id=r.guest_id WHERE f.property_id='prop-seoul' ORDER BY f.created_at DESC LIMIT 250"),
    db.prepare("SELECT rr.*,w.window_no,w.name window_name,r.confirmation_no FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id JOIN reservations r ON r.id=rr.reservation_id WHERE rr.property_id='prop-seoul' AND rr.active=1 ORDER BY rr.created_at DESC"),
    db.prepare("SELECT * FROM transaction_codes WHERE property_id='prop-seoul' AND active=1 ORDER BY category,code"),
    db.prepare("SELECT a.*,p.name profile_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_accounts a JOIN account_profiles p ON p.id=a.account_profile_id LEFT JOIN ar_ledger_entries l ON l.ar_account_id=a.id WHERE a.property_id='prop-seoul' GROUP BY a.id,p.id ORDER BY a.account_no"),
    db.prepare("SELECT i.*,a.account_no,a.name account_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i JOIN ar_accounts a ON a.id=i.ar_account_id LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id WHERE i.property_id='prop-seoul' GROUP BY i.id,a.id ORDER BY i.issued_date DESC,i.invoice_no DESC"),
    db.prepare(`SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) guest_ledger,(SELECT COALESCE(SUM(debit-credit),0) FROM ar_ledger_entries WHERE property_id='prop-seoul') ar_ledger,COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount WHEN kind='CHARGE_REVERSAL' THEN -amount ELSE 0 END),0) gross_revenue,COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='PAYMENT_REVERSAL' THEN -amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0) net_payments FROM folio_entries WHERE property_id='prop-seoul'`),
    db.prepare("SELECT * FROM channel_connections WHERE property_id='prop-seoul' ORDER BY provider,name"),
    db.prepare("SELECT cc.*,c.provider,c.name connection_name FROM channel_contracts cc JOIN channel_connections c ON c.id=cc.connection_id WHERE cc.property_id='prop-seoul' ORDER BY c.provider,c.name"),
    db.prepare("SELECT m.*,c.provider,c.name connection_name,rt.code room_type_code,rt.name room_type_name FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id JOIN room_types rt ON rt.id=m.room_type_id WHERE m.property_id='prop-seoul' ORDER BY c.provider,rt.code,m.rate_plan"),
    db.prepare("SELECT a.*,c.provider,m.external_room_type_id,m.external_rate_plan_id,rt.code room_type_code FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id JOIN channel_mappings m ON m.id=a.mapping_id JOIN room_types rt ON rt.id=m.room_type_id WHERE a.property_id='prop-seoul' ORDER BY a.created_at DESC LIMIT 150"),
    db.prepare("SELECT i.*,c.name connection_name FROM inbound_channel_messages i JOIN channel_connections c ON c.id=i.connection_id WHERE i.property_id='prop-seoul' ORDER BY i.received_at DESC LIMIT 150"),
    db.prepare("SELECT l.*,c.provider,r.confirmation_no FROM channel_reservation_links l JOIN channel_connections c ON c.id=l.connection_id JOIN reservations r ON r.id=l.reservation_id WHERE l.property_id='prop-seoul' ORDER BY l.updated_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM integration_delivery_attempts WHERE property_id='prop-seoul' ORDER BY created_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM outbox_events WHERE property_id='prop-seoul' ORDER BY created_at DESC LIMIT 150"),
  ]);
  const property = propertyResult.results[0] as Record<string,unknown>; const reservations=reservationResult.results as Array<Record<string,unknown>>; const rooms=roomResult.results as Array<Record<string,unknown>>;
  const activeRooms=rooms.filter(x=>Number(x.active??1)===1); const metrics = { rooms:activeRooms.length, occupied:activeRooms.filter(x=>x.front_desk_status==='OCCUPIED').length, dirty:activeRooms.filter(x=>x.housekeeping_status==='DIRTY').length, ready:activeRooms.filter(x=>x.housekeeping_status==='CLEAN'||x.housekeeping_status==='INSPECTED').length };
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
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&Number(room.active??1)===1&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`);const sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
  const groups={accounts:accountProfilesResult.results,blocks:blocksResult.results,inventory:blockInventoryResult.results,rooming:roomingResult.results};
  const finance={windows:folioWindowsResult.results,entries:folioEntriesResult.results,routing:routingRulesResult.results,transactionCodes:transactionCodesResult.results,arAccounts:arAccountsResult.results,arInvoices:arInvoicesResult.results,trialBalance:trialBalanceResult.results[0]??{guest_ledger:0,ar_ledger:0,gross_revenue:0,net_payments:0}};
  const integrations={connections:channelConnectionsResult.results,contracts:channelContractsResult.results,mappings:channelMappingsResult.results,ari:ariUpdatesResult.results,inbound:inboundMessagesResult.results,links:channelLinksResult.results,attempts:integrationAttemptsResult.results,outbox:outboxResult.results};
  return { property, reservations, rooms, metrics, principal, controls, inventory, groups, finance, integrations };
}

async function coreSnapshot(db:D1,principal:Principal) {
  // The core projection deliberately omits finance, groups, and integrations for
  // fast first paint; `completeness` prevents consumers from mistaking empty arrays
  // for authoritative domain data.
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult]=await db.batch([
    db.prepare("SELECT * FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id='prop-seoul' GROUP BY r.id,g.id,rt.id,rm.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') WHERE rm.property_id='prop-seoul' ORDER BY rm.number`),
    db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id='prop-seoul') AND r.departure_date>(SELECT business_date FROM properties WHERE id='prop-seoul') AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND f.kind='CHARGE' AND f.code='ROOM')"),
    db.prepare("SELECT * FROM room_types WHERE property_id='prop-seoul' ORDER BY code"),
    db.prepare("SELECT room_type_id, stay_date, COUNT(*) booked FROM reservation_type_nights WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day') GROUP BY room_type_id, stay_date"),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day')"),
  ]);
  const property=propertyResult.results[0] as Record<string,unknown>,reservations=reservationResult.results as Array<Record<string,unknown>>,rooms=roomResult.results as Array<Record<string,unknown>>,activeRooms=rooms.filter(item=>Number(item.active??1)===1);
  const metrics={rooms:activeRooms.length,occupied:activeRooms.filter(item=>item.front_desk_status==='OCCUPIED').length,dirty:activeRooms.filter(item=>item.housekeeping_status==='DIRTY').length,ready:activeRooms.filter(item=>item.housekeeping_status==='CLEAN'||item.housekeeping_status==='INSPECTED').length};
  const arrivals=reservations.filter(item=>item.arrival_date===property.business_date&&item.status==='DUE_IN').length,cashiers=Number((openCashierResult.results[0] as {count?:number})?.count??0),failed=Number((failedResult.results[0] as {count?:number})?.count??0),oos=rooms.filter(item=>item.housekeeping_status==='OUT_OF_SERVICE').length;
  const blockers=[{code:"UNRESOLVED_ARRIVALS",label:"미처리 도착 예약",count:arrivals,blocking:true},{code:"OPEN_CASHIERS",label:"미마감 캐셔",count:cashiers,blocking:true},{code:"FAILED_INTERFACES",label:"인터페이스 전송 실패",count:failed,blocking:false},{code:"OUT_OF_SERVICE",label:"판매 중지 객실",count:oos,blocking:false}],priorAudit=auditResult.results[0]??null;
  const controls={blockers,canClose:blockers.every(item=>!item.blocking||item.count===0)&&!priorAudit,openCashier:actorCashierResult.results[0]??null,priorAudit,pendingRoomPostings:Number((postingsResult.results[0] as {count?:number})?.count??0)};
  const dates=Array.from({length:14},(_,index)=>{const day=new Date(`${String(property.business_date)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+index);return day.toISOString().slice(0,10)}),typeNights=typeNightsResult.results as Array<Record<string,unknown>>,controlRows=inventoryControlsResult.results as Array<Record<string,unknown>>,roomTypes=roomTypesResult.results as Array<Record<string,unknown>>,booked=new Map(typeNights.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.booked)])),inventoryControls=new Map(controlRows.map(row=>[`${row.room_type_id}:${row.stay_date}`,row]));
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&Number(room.active??1)===1&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`),sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
  return {property,reservations,rooms,metrics,principal,controls,inventory,groups:{accounts:[],blocks:[],inventory:[],rooming:[]},finance:{windows:[],entries:[],routing:[],transactionCodes:[],arAccounts:[],arInvoices:[],trialBalance:{guest_ledger:0,ar_ledger:0,gross_revenue:0,net_payments:0}},integrations:{connections:[],contracts:[],mappings:[],ari:[],inbound:[],links:[],attempts:[],outbox:[]},completeness:"core"};
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
// Caches are partitioned by property and principal because cashier state and
// permissions are user-specific. Every successful mutation calls invalidateSnapshots
// so the short TTL cannot serve stale inventory, balances, or authorization views.
const snapshotCache = new Map<string,{expires:number,value:Promise<Snapshot>}>();
const coreSnapshotCache = new Map<string,{expires:number,value:Promise<Awaited<ReturnType<typeof coreSnapshot>>>}>();
const snapshotRepresentationCache = new Map<string,{expires:number,json:Promise<string>,gzip:Promise<ArrayBuffer>}>();
const coreRepresentationCache = new Map<string,{expires:number,json:Promise<string>,gzip:Promise<ArrayBuffer>}>();
type ReportResult=Awaited<ReturnType<typeof runReport>>;
const reportCache=new Map<string,{expires:number;value:Promise<ReportResult>}>();
function invalidateSnapshots() { snapshotCache.clear(); coreSnapshotCache.clear(); snapshotRepresentationCache.clear(); coreRepresentationCache.clear(); reportCache.clear(); }
async function cachedSnapshot(db:D1, principal:Principal) {
  const key=`${principal.propertyId}:${principal.email}`; const cached=snapshotCache.get(key); const now=Date.now();
  if (cached && cached.expires>now) return cached.value;
  const value=snapshot(db,principal); snapshotCache.set(key,{expires:now+3000,value});
  try { return await value; } catch (error) { snapshotCache.delete(key); throw error; }
}
async function cachedCoreSnapshot(db:D1,principal:Principal){const key=`${principal.propertyId}:${principal.email}`,now=Date.now(),cached=coreSnapshotCache.get(key);if(cached&&cached.expires>now)return cached.value;const value=coreSnapshot(db,principal);coreSnapshotCache.set(key,{expires:now+3000,value});try{return await value}catch(error){coreSnapshotCache.delete(key);throw error}}
async function gzipSnapshot(json: Promise<string>) {
  const stream = new Blob([await json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
async function cachedSnapshotResponse(db:D1,principal:Principal,request:Request) {
  const key=`${principal.propertyId}:${principal.email}`,now=Date.now();let cached=snapshotRepresentationCache.get(key);
  if(!cached||cached.expires<=now){const json=cachedSnapshot(db,principal).then(value=>JSON.stringify(value));cached={expires:now+3000,json,gzip:gzipSnapshot(json)};snapshotRepresentationCache.set(key,cached);}
  const common={"Cache-Control":"private, no-store","Content-Type":"application/json; charset=utf-8","Vary":"Accept-Encoding"};
  if(/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get("accept-encoding")||""))return new Response(await cached.gzip,{headers:{...common,"Content-Encoding":"gzip"}});
  return new Response(await cached.json,{headers:common});
}
async function cachedCoreSnapshotResponse(db:D1,principal:Principal,request:Request){const key=`${principal.propertyId}:${principal.email}`,now=Date.now();let cached=coreRepresentationCache.get(key);if(!cached||cached.expires<=now){const json=cachedCoreSnapshot(db,principal).then(value=>JSON.stringify(value));cached={expires:now+3000,json,gzip:gzipSnapshot(json)};coreRepresentationCache.set(key,cached)}const common={"Cache-Control":"private, no-store","Content-Type":"application/json; charset=utf-8","Vary":"Accept-Encoding"};if(/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get("accept-encoding")||""))return new Response(await cached.gzip,{headers:{...common,"Content-Encoding":"gzip"}});return new Response(await cached.json,{headers:common})}
async function cachedReport(db:D1,params:URLSearchParams,principal:Principal){const key=`${principal.propertyId}:${principal.email}:${params.toString()}`,now=Date.now(),cached=reportCache.get(key);if(cached&&cached.expires>now)return cached.value;if(reportCache.size>200){for(const [cacheKey,item] of reportCache)if(item.expires<=now)reportCache.delete(cacheKey);if(reportCache.size>200)reportCache.clear();}const value=runReport(db,params,principal);reportCache.set(key,{expires:now+5000,value});try{return await value;}catch(error){reportCache.delete(key);throw error;}}

export async function GET(request: Request) {
  // All read models pass through authentication and the property-scoped adapter.
  // `view` selects a bounded projection; no branch accepts a raw table or SQL name.
  const rootDb = getPmsDatabase(runtimeBindings);
  await ready(rootDb); const principal = await principalFor(request, rootDb);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  const db = scopePmsDatabase(rootDb, principal.propertyId);
  const url=new URL(request.url);
  if(url.searchParams.get("view")==="core") return cachedCoreSnapshotResponse(db,principal,request);
  if(url.searchParams.get("view")==="inventory") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
       return Response.json(await loadInventoryCalendar(db,from,to,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="accounting") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
       return Response.json(await loadAccountingCenter(db,from,to,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="website") {
    try { return Response.json(await loadWebsiteAdmin(db,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}}); }
    catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="report") {
    try { return Response.json(await cachedReport(db,url.searchParams,principal),{headers:{"Cache-Control":"private, no-store"}}); }
    catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  return cachedSnapshotResponse(db,principal,request);
}

export async function POST(request: Request) {
  // Mutation pipeline order is security-sensitive: authenticate, reject cross-origin
  // requests, scope the database, authorize the action capability, validate the
  // idempotency key, then execute the command and invalidate read caches.
  const rootDb = getPmsDatabase(runtimeBindings);
  await ready(rootDb); const principal = await principalFor(request, rootDb);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"허용되지 않은 요청 출처입니다."},{status:403});
  let rateLimit;
  try { rateLimit=await consumeRateLimit(request,"pms-write",120,60_000,`${principal.propertyId}:${principal.email}`,rootDb); }
  catch { return Response.json({error:"요청 보호 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."},{status:503,headers:{"Retry-After":"30"}}); }
  if(!rateLimit.allowed)return Response.json({error:"변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."},{status:429,headers:rateLimitHeaders(rateLimit)});
  const db = scopePmsDatabase(rootDb, principal.propertyId);
  let body: Record<string, string>;
  try { body = await request.json() as Record<string, string>; }
  catch { return Response.json({error:"요청 본문이 올바른 JSON이 아닙니다."},{status:400}); }
  const now = new Date().toISOString(); const actor = principal.email;
  const requiredCapability = actionCapability[body.action];
  if (!requiredCapability || !principal.capabilities.includes(requiredCapability)) return Response.json({error:"이 작업을 수행할 권한이 없습니다."},{status:403});
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200 || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) return Response.json({error:"변경 요청에는 유효한 Idempotency-Key가 필요합니다."},{status:400});
  // Every successful mutation appends this strict unique receipt inside the same
  // transaction as its domain writes. Do not use OR IGNORE here: two concurrent
  // retries must make the losing transaction roll back all side effects.
  const mutationReceipt = () => db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now);
  const duplicate = await db.prepare("SELECT key FROM idempotency_keys WHERE key=?").bind(idempotencyKey).first();
  if (duplicate && body.action!=="export_report") return Response.json(await cachedSnapshot(db, principal), {headers:{"X-Idempotent-Replay":"true"}});
  if(body.action==="export_report") {
    try {
      const params=new URLSearchParams();for(const key of ["report","q","from","to","status","source","roomTypeId"]){if(body[key])params.set(key,body[key]);}
      const report=await runReport(db,params,principal,{exportMode:true});
      if(duplicate)return Response.json({...report,replayed:true},{headers:{"X-Idempotent-Replay":"true"}});
      if(report.pagination.total>report.export.maxRows)return Response.json({error:`결과가 ${report.export.maxRows.toLocaleString()}행을 초과합니다. 기간 또는 필터를 좁혀 주세요.`},{status:413});
      const exportId=crypto.randomUUID(),filters=JSON.stringify(report.filters),format=body.format==="CSV"?"CSV":"XLSX";
      await db.batch([
        db.prepare("INSERT INTO report_exports VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)").bind(exportId,report.report.key,format,filters,report.rows.length,actor,now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'EXPORT_REPORT', 'report_export', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,exportId,JSON.stringify({report:report.report.key,filters,rowCount:report.rows.length,format}),now),
        mutationReceipt(),
      ]);
      invalidateSnapshots();
      return Response.json({...report,exportId});
    } catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  const reservation = body.reservationId ? await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id='prop-seoul'").bind(body.reservationId).first<Record<string, unknown>>() : null;
  const propertyState = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(propertyState?.business_date);
  try {
    if(await handleExtendedAction(db,body,principal,businessDate,now,idempotencyKey)) {
      // Extended revenue, inventory and accounting actions are committed by the
      // specialized service and share the same snapshot response contract.
    } else if(body.action==="create_room_type") {
      const code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300);
      if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"타입 코드는 영문·숫자 2~12자, 이름은 2~80자, 기준 인원은 1~20명으로 입력하세요."},{status:400});
      const typeId=crypto.randomUUID();await db.batch([
        db.prepare("INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 1)").bind(typeId,code,name,baseRate,capacity,description),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ROOM_TYPE', 'room_type', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,typeId,JSON.stringify({code,name,baseRate,capacity,description,active:true}),now),
        ...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[]),
      ]);
    } else if(body.action==="update_room_type") {
      const current=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(),code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300),active=body.active!=="false";
      if(!current)return Response.json({error:"객실 타입을 찾지 못했습니다."},{status:404});if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"객실 타입 입력값을 확인하세요."},{status:400});
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실 타입을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      if(!active){const future=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE room_type_id=? AND property_id='prop-seoul' AND stay_date>=?").bind(body.roomTypeId,businessDate).first<{count:number}>();if(Number(future?.count||0)>0)return Response.json({error:"미래 예약이 있는 객실 타입은 비활성화할 수 없습니다."},{status:409});}
      await db.batch([db.prepare("UPDATE room_types SET code=?,name=?,base_rate=?,capacity=?,description=?,active=?,version=version+1 WHERE id=? AND property_id='prop-seoul' AND version=?").bind(code,name,baseRate,capacity,description,active?1:0,body.roomTypeId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_ROOM_TYPE', 'room_type', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomTypeId,JSON.stringify(current),JSON.stringify({code,name,baseRate,capacity,description,active,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="create_room") {
      const number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"활성 객실 타입, 16자 이하 객실번호, -10~250층을 입력하세요."},{status:400});const roomId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, 'prop-seoul', ?, ?, ?, 'VACANT', 'CLEAN', ?, 1, 1)").bind(roomId,body.roomTypeId,number,floor,JSON.stringify(features)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ROOM', 'room', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,roomId,JSON.stringify({number,floor,roomTypeId:body.roomTypeId,features}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="bulk_create_rooms") {
      const start=Number(body.startNumber),count=Number(body.count),floor=Number(body.floor),padding=Math.min(8,Math.max(1,Number(body.padding)||String(body.startNumber||"").length)),prefix=(body.prefix||"").trim().toUpperCase().slice(0,8),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>500||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"시작 번호와 생성 수량(1~500), 층, 활성 객실 타입을 확인하세요."},{status:400});
      const numbers=Array.from({length:count},(_,index)=>`${prefix}${String(start+index).padStart(padding,"0")}`);if(numbers.some(number=>number.length>16))return Response.json({error:"생성되는 객실번호는 16자를 초과할 수 없습니다."},{status:400});const existing=await db.prepare("SELECT number FROM rooms WHERE property_id='prop-seoul'").all<{number:string}>(),known=new Set(existing.results.map(row=>row.number));const duplicate=numbers.find(number=>known.has(number));if(duplicate)return Response.json({error:`객실 ${duplicate}번이 이미 존재합니다.`},{status:409});
      const roomStatements=numbers.map(number=>db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, 'prop-seoul', ?, ?, ?, 'VACANT', 'CLEAN', ?, 1, 1)").bind(crypto.randomUUID(),body.roomTypeId,number,floor,JSON.stringify(features)));
      await db.batch([...roomStatements,db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'BULK_CREATE_ROOMS', 'room_batch', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,crypto.randomUUID(),JSON.stringify({roomTypeId:body.roomTypeId,prefix,start,count,floor,numbers}),now),db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]);
    } else if(body.action==="update_room") {
      const current=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(body.roomId).first<Record<string,unknown>>(),number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),active=body.active!=="false",type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!current)return Response.json({error:"객실을 찾지 못했습니다."},{status:404});if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"객실 입력값을 확인하세요."},{status:400});const changingType=String(current.room_type_id)!==body.roomTypeId,future=await db.prepare("SELECT COUNT(*) count FROM reservation_nights WHERE room_id=? AND property_id='prop-seoul' AND stay_date>=?").bind(body.roomId,businessDate).first<{count:number}>();if((changingType||!active)&&Number(future?.count||0)>0)return Response.json({error:"미래 예약이 배정된 객실은 타입 변경 또는 비활성화할 수 없습니다."},{status:409});if(!active&&current.front_desk_status==="OCCUPIED")return Response.json({error:"투숙 중인 객실은 비활성화할 수 없습니다."},{status:409});const housekeeping=active?(current.housekeeping_status==="OUT_OF_SERVICE"?"CLEAN":String(current.housekeeping_status)):"OUT_OF_SERVICE";
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      await db.batch([db.prepare("UPDATE rooms SET room_type_id=?,number=?,floor=?,features=?,active=?,housekeeping_status=?,version=version+1 WHERE id=? AND property_id='prop-seoul' AND version=?").bind(body.roomTypeId,number,floor,JSON.stringify(features),active?1:0,housekeeping,body.roomId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_ROOM', 'room', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomId,JSON.stringify(current),JSON.stringify({roomTypeId:body.roomTypeId,number,floor,features,active,housekeeping,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if (body.action === "create_reservation") {
      const arrival = new Date(`${body.arrivalDate}T00:00:00Z`), departure = new Date(`${body.departureDate}T00:00:00Z`);
      if (!body.firstName?.trim() || !body.lastName?.trim() || !Number.isFinite(arrival.valueOf()) || departure <= arrival) return Response.json({error:"고객명과 올바른 숙박 일정을 입력하세요."},{status:400});
      const type = await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first<Record<string,unknown>>();
      if (!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const room = body.roomId ? await db.prepare("SELECT * FROM rooms WHERE id=? AND room_type_id=? AND property_id='prop-seoul' AND active=1").bind(body.roomId,body.roomTypeId).first<Record<string,unknown>>() : null;
      if (body.roomId && !room) return Response.json({error:"선택한 객실과 객실 타입이 일치하지 않습니다."},{status:409});
      const guestId=crypto.randomUUID(), reservationId=crypto.randomUUID(), confirmation=`SEL-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`;
      const statements = [
        db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', ?, '[]', ?)").bind(guestId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.nationality||"KR",now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, ?, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, ?, '', 1, ?, ?)").bind(reservationId,confirmation,guestId,body.roomTypeId,body.roomId||null,body.arrivalDate,body.departureDate,Number(body.adults)||1,Number(body.children)||0,body.source||"Direct",body.ratePlan||"BAR",Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for (const stayDate of datesBetween(body.arrivalDate,body.departureDate)) {
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomTypeId,stayDate));
        if (body.roomId) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomId,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_RESERVATION', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,reservationId,JSON.stringify({confirmation,status:"DUE_IN"}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),reservationId,JSON.stringify({reservationId,confirmation}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "edit_reservation" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 수정할 수 있습니다."},{status:409});
      if(await db.prepare("SELECT id FROM rooming_list_entries WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId).first()) return Response.json({error:"그룹 픽업 예약은 블록 rooming list에서 수정하세요."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const type=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!stayDates.length) return Response.json({error:"올바른 숙박 일정을 입력하세요."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const retainedRoom=reservation.room_id && reservation.room_type_id===body.roomTypeId ? String(reservation.room_id) : null;
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'EDIT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_type_id=?, room_id=?, arrival_date=?, departure_date=?, adults=?, children=?, rate_plan=?, nightly_rate=?, eta=?, notes=?, version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN' AND version=?").bind(body.roomTypeId,retainedRoom,body.arrivalDate,body.departureDate,Math.max(1,Number(body.adults)||1),Math.max(0,Number(body.children)||0),body.ratePlan||String(reservation.rate_plan),Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,body.notes||"",now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of stayDates){
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomTypeId,stayDate));
        if(retainedRoom) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,retainedRoom,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'EDIT_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({roomTypeId:body.roomTypeId,arrivalDate:body.arrivalDate,departureDate:body.departureDate,roomId:retainedRoom}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.updated', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,version:expectedVersion+1}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "assign_room" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약에만 객실을 배정할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.room_type_id!==reservation.room_type_id) return Response.json({error:"예약 객실 타입과 배정 객실 타입이 일치하지 않습니다."},{status:409});
      if(room.housekeeping_status==="OUT_OF_SERVICE") return Response.json({error:"판매 중지 객실은 배정할 수 없습니다."},{status:409});
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'ASSIGN_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of datesBetween(String(reservation.arrival_date),String(reservation.departure_date))) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ASSIGN_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.room_assigned', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:body.roomId}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "move_room" && reservation) {
      if(reservation.status!=="IN_HOUSE"||!reservation.room_id) return Response.json({error:"투숙 중이고 객실이 배정된 예약만 룸 무브할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"룸 무브 사유를 입력하세요."},{status:400});
      if(body.roomId===reservation.room_id) return Response.json({error:"현재 객실과 다른 객실을 선택하세요."},{status:400});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.front_desk_status!=="VACANT"||!["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"공실이며 청소 또는 점검이 완료된 객실만 이동할 수 있습니다."},{status:409});
      const futureDates=datesBetween(businessDate,String(reservation.departure_date)); if(!futureDates.length) return Response.json({error:"남은 숙박일이 없습니다."},{status:409});
      const moveId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'MOVE_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul' AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='IN_HOUSE' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=? AND property_id='prop-seoul'").bind(String(reservation.room_id)),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND property_id='prop-seoul' AND front_desk_status='VACANT'").bind(body.roomId),
        db.prepare("INSERT INTO room_moves VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?)").bind(moveId,body.reservationId,String(reservation.room_id),body.roomId,businessDate,body.reason.trim(),body.notes||"",actor,now),
      ];
      for(const stayDate of futureDates) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 1, NULL, '룸 무브 출발 객실', ?)").bind(crypto.randomUUID(),String(reservation.room_id),businessDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MOVE_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId,reason:body.reason}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.room_moved', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,fromRoomId:reservation.room_id,toRoomId:body.roomId,reason:body.reason}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "cancel_reservation" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약만 취소할 수 있습니다."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"예약 취소 사유를 입력하세요."},{status:400});
      const groupEntry=await db.prepare("SELECT * FROM rooming_list_entries WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId).first<Record<string,unknown>>();
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'CANCELLED', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CANCELLED', version=version+1, notes=notes || ?, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN'").bind(`\n[취소] ${body.reason.trim()}`,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CANCEL_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CANCELLED",reason:body.reason.trim()}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.cancelled', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,reason:body.reason.trim()}),now),
      ];
      if(groupEntry){statements.push(db.prepare("DELETE FROM block_pickup_nights WHERE rooming_entry_id=? AND property_id='prop-seoul'").bind(String(groupEntry.id)));statements.push(db.prepare("UPDATE rooming_list_entries SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul'").bind(now,String(groupEntry.id)));}
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "update_inventory_control") {
      const stayDate=String(body.stayDate), roomType=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!roomType) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const horizon=new Date(`${businessDate}T00:00:00Z`);horizon.setUTCDate(horizon.getUTCDate()+365); if(stayDate<businessDate||stayDate>horizon.toISOString().slice(0,10)) return Response.json({error:"영업일부터 365일 범위만 수정할 수 있습니다."},{status:400});
      const capacity=await db.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id='prop-seoul' AND room_type_id=? AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE'").bind(body.roomTypeId).first<{count:number}>(); const physical=Number(capacity?.count??0);
      const sellLimit=body.sellLimit===""?physical:Number(body.sellLimit), minStay=Number(body.minStay||1), price=body.priceOverride===""?null:Number(body.priceOverride), closed=body.closed==="true"?1:0,websiteClosed=body.websiteClosed==="true"?1:0;
      if(!Number.isInteger(sellLimit)||sellLimit<0||sellLimit>physical||!Number.isInteger(minStay)||minStay<1||minStay>30||price!==null&&(!Number.isFinite(price)||price<0)) return Response.json({error:"판매 수량·최소 숙박·요금을 올바르게 입력하세요."},{status:400});
      const reserved=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first<{count:number}>(); if(!closed&&sellLimit<Number(reserved?.count??0)) return Response.json({error:"이미 확정된 예약 수보다 판매 한도를 낮출 수 없습니다."},{status:409});
      const existing=await db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first(); const controlId=String((existing as Record<string,unknown>|null)?.id??crypto.randomUUID());
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO inventory_controls(id,property_id,room_type_id,stay_date,sell_limit,closed,min_stay,close_to_arrival,close_to_departure,price_override,website_closed,updated_at,updated_by) VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(property_id,room_type_id,stay_date) DO UPDATE SET sell_limit=excluded.sell_limit,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,price_override=excluded.price_override,website_closed=excluded.website_closed,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(controlId,body.roomTypeId,stayDate,sellLimit,closed,minStay,body.cta==="true"?1:0,body.ctd==="true"?1:0,price,websiteClosed,now,actor),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_INVENTORY_CONTROL', 'inventory_control', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,controlId,existing?JSON.stringify(existing):null,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),websiteClosed:Boolean(websiteClosed),minStay,cta:body.cta==="true",ctd:body.ctd==="true",price}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'inventory.updated', 'room_type', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.roomTypeId,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,price}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "create_account_profile") {
      const type=String(body.type),name=body.name?.trim(); if(!["COMPANY","TRAVEL_AGENT","SOURCE","GROUP"].includes(type)||!name) return Response.json({error:"프로필 유형과 이름을 올바르게 입력하세요."},{status:400});
      const profileId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO account_profiles VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)").bind(profileId,type,name,body.externalId?.trim()||null,body.email?.trim()||null,body.phone?.trim()||null,body.negotiatedRateCode?.trim()||null,body.creditStatus||"CASH",body.notes||"",now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ACCOUNT_PROFILE', 'account_profile', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,profileId,JSON.stringify({type,name,externalId:body.externalId||null}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'profile.created', 'account_profile', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),profileId,JSON.stringify({profileId,type,name}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "create_business_block") {
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.name?.trim()||!stayDates.length) return Response.json({error:"블록 이름과 올바른 일정을 입력하세요."},{status:400});
      let allocations:Array<{roomTypeId:string;rooms:number;rate:number}>; try{allocations=JSON.parse(body.allocations||"[]") as Array<{roomTypeId:string;rooms:number;rate:number}>}catch{return Response.json({error:"객실 할당 정보가 올바르지 않습니다."},{status:400})}
      allocations=allocations.filter(item=>item.roomTypeId&&Number.isInteger(Number(item.rooms))&&Number(item.rooms)>0&&Number(item.rate)>=0).map(item=>({...item,rooms:Number(item.rooms),rate:Number(item.rate)})); if(!allocations.length) return Response.json({error:"한 개 이상의 객실 타입 할당을 입력하세요."},{status:400});
      const types=await db.prepare("SELECT id FROM room_types WHERE property_id='prop-seoul'").all<{id:string}>(); const validTypes=new Set(types.results.map(type=>type.id)); if(allocations.some(item=>!validTypes.has(item.roomTypeId))) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const accountId=body.accountProfileId||null,groupId=body.groupProfileId||null; if(accountId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id='prop-seoul' AND type IN ('COMPANY','TRAVEL_AGENT','SOURCE') AND active=1").bind(accountId).first()) return Response.json({error:"유효한 회사·여행사·소스 프로필을 선택하세요."},{status:400}); if(groupId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id='prop-seoul' AND type='GROUP' AND active=1").bind(groupId).first()) return Response.json({error:"유효한 그룹 프로필을 선택하세요."},{status:400});
      const blockId=crypto.randomUUID(),code=body.code?.trim()||`BLK-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,status=["TENTATIVE","DEFINITE"].includes(body.status)?body.status:"TENTATIVE",cutoffDate=body.cutoffDate||body.arrivalDate,deduct=body.deductInventory==="false"?0:1;
      const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO business_blocks VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 1, NULL, ?, ?)").bind(blockId,code,body.name.trim(),accountId,groupId,body.arrivalDate,body.departureDate,status,body.reservationMethod||"ROOMING_LIST",deduct,cutoffDate,body.notes||"",now,now)];
      for(const allocation of allocations) for(const stayDate of stayDates) statements.push(db.prepare("INSERT INTO block_inventory VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)").bind(crypto.randomUUID(),blockId,allocation.roomTypeId,stayDate,allocation.rooms,allocation.rooms,allocation.rate,cutoffDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_BUSINESS_BLOCK', 'business_block', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,blockId,JSON.stringify({code,name:body.name,status,arrivalDate:body.arrivalDate,departureDate:body.departureDate,allocations}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.created', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),blockId,JSON.stringify({blockId,code,status}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "update_block_inventory") {
      const row=await db.prepare("SELECT bi.*,bb.status block_status FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id WHERE bi.block_id=? AND bi.room_type_id=? AND bi.stay_date=? AND bi.property_id='prop-seoul'").bind(body.blockId,body.roomTypeId,body.stayDate).first<Record<string,unknown>>(); if(!row||!["TENTATIVE","DEFINITE"].includes(String(row.block_status))) return Response.json({error:"수정 가능한 블록 재고를 찾지 못했습니다."},{status:409});
      const rooms=Number(body.rooms),rate=Number(body.rate); if(!Number.isInteger(rooms)||rooms<Number(row.picked_up)||!Number.isFinite(rate)||rate<0) return Response.json({error:"픽업 수보다 낮지 않은 객실 수와 올바른 요금을 입력하세요."},{status:400});
      const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=?,rate=?,version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND version=?").bind(rooms,rate,now,row.id,Number(row.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_BLOCK_INVENTORY', 'block_inventory', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(row.id),JSON.stringify(row),JSON.stringify({currentRooms:rooms,rate}),now),db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.inventory_updated', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId,roomTypeId:body.roomTypeId,stayDate:body.stayDate,rooms,rate}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "add_rooming_entry") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block) return Response.json({error:"픽업 가능한 블록을 찾지 못했습니다."},{status:409});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.firstName?.trim()||!body.lastName?.trim()||!stayDates.length||body.arrivalDate<String(block.arrival_date)||body.departureDate>String(block.departure_date)) return Response.json({error:"고객명과 블록 범위 안의 일정을 입력하세요."},{status:400});
      const grid=await db.prepare("SELECT * FROM block_inventory WHERE block_id=? AND room_type_id=? AND property_id='prop-seoul' AND stay_date>=? AND stay_date<? ORDER BY stay_date").bind(body.blockId,body.roomTypeId,body.arrivalDate,body.departureDate).all<Record<string,unknown>>(); if(grid.results.length!==stayDates.length) return Response.json({error:"선택한 객실 타입의 블록 할당이 일정 전체에 없습니다."},{status:409});
      const entryId=crypto.randomUUID(),rate=Number(body.rate)||Number(grid.results[0]?.rate??0); const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO rooming_list_entries VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, 1, ?, ?)").bind(entryId,body.blockId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.arrivalDate,body.departureDate,body.roomTypeId,rate,body.notes||"",now,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ADD_ROOMING_ENTRY', 'rooming_list_entry', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,entryId,JSON.stringify({blockId:body.blockId,firstName:body.firstName,lastName:body.lastName,roomTypeId:body.roomTypeId}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "pickup_rooming_entry") {
      const entry=await db.prepare("SELECT rl.*,bb.code block_code,bb.status block_status FROM rooming_list_entries rl JOIN business_blocks bb ON bb.id=rl.block_id AND bb.property_id=rl.property_id WHERE rl.id=? AND rl.property_id='prop-seoul'").bind(body.entryId).first<Record<string,unknown>>(); if(!entry||entry.status!=="PENDING"||!["TENTATIVE","DEFINITE"].includes(String(entry.block_status))) return Response.json({error:"이미 픽업됐거나 픽업할 수 없는 rooming list 항목입니다."},{status:409});
      const reservationId=crypto.randomUUID(),guestId=crypto.randomUUID(),confirmation=`SEL-${String(entry.arrival_date).replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,stayDates=datesBetween(String(entry.arrival_date),String(entry.departure_date)); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', 'KR', '[]', ?)").bind(guestId,String(entry.first_name),String(entry.last_name),entry.email??null,entry.phone??null,now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', 1, 0, 'Group', ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,String(entry.room_type_id),String(entry.arrival_date),String(entry.departure_date),String(entry.block_code),Number(entry.rate),`Block ${entry.block_code} · Rooming list`,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for(const stayDate of stayDates){statements.push(db.prepare("INSERT INTO block_pickup_nights(property_id,block_id,rooming_entry_id,room_type_id,stay_date,created_at) VALUES ('prop-seoul',?,?,?,?,?)").bind(String(entry.block_id),String(entry.id),String(entry.room_type_id),stayDate,now));statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,String(entry.room_type_id),stayDate));}
      statements.push(db.prepare("UPDATE rooming_list_entries SET status='PICKED_UP',reservation_id=?,version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='PENDING'").bind(reservationId,now,String(entry.id))); statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'PICKUP_ROOMING_ENTRY', 'rooming_list_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(entry.id),JSON.stringify(entry),JSON.stringify({status:"PICKED_UP",reservationId,confirmation}),now)); statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.reservation_picked_up', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),String(entry.block_id),JSON.stringify({blockId:entry.block_id,entryId:entry.id,reservationId,confirmation}),now)); if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "cutoff_block") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block)return Response.json({error:"마감 가능한 블록을 찾지 못했습니다."},{status:409}); const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=? AND property_id='prop-seoul'").bind(now,body.blockId),db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE')").bind(now,now,body.blockId),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CUTOFF_BLOCK', 'business_block', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.blockId,JSON.stringify(block),JSON.stringify({status:"CUTOFF"}),now),db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId}),now)];if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));await db.batch(statements);
    } else if (body.action === "create_channel_connection") {
      const provider=body.provider?.trim().toUpperCase(),externalPropertyId=body.externalPropertyId?.trim();if(!provider||!externalPropertyId)return Response.json({error:"채널과 외부 호텔 ID를 입력하세요."},{status:400});const connectionId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_connections VALUES (?, 'prop-seoul', ?, ?, ?, 'SANDBOX', 'ACTIVE', NULL, ?, ?, ?)").bind(connectionId,provider,externalPropertyId,body.name?.trim()||`${provider} Sandbox`,now,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_CHANNEL_CONNECTION', 'channel_connection', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,connectionId,JSON.stringify({provider,externalPropertyId,environment:"SANDBOX"}),now)]);
    } else if (body.action === "create_channel_mapping") {
      const connection=await db.prepare("SELECT id FROM channel_connections WHERE id=? AND property_id='prop-seoul' AND status='ACTIVE'").bind(body.connectionId).first(),roomType=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first();if(!connection||!roomType||!body.externalRoomTypeId?.trim()||!body.externalRatePlanId?.trim())return Response.json({error:"활성 연결, 객실 타입, 외부 room/rate ID를 입력하세요."},{status:400});const mappingId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_mappings VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 1, ?, ?)").bind(mappingId,body.connectionId,body.roomTypeId,body.externalRoomTypeId.trim(),body.ratePlan||"OTA",body.externalRatePlanId.trim(),now,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_CHANNEL_MAPPING', 'channel_mapping', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,mappingId,JSON.stringify({connectionId:body.connectionId,roomTypeId:body.roomTypeId,externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId}),now)]);
    } else if (body.action === "queue_ari_delta") {
      const mapping=await db.prepare("SELECT m.*,c.provider FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id WHERE m.id=? AND m.property_id='prop-seoul' AND c.property_id='prop-seoul' AND m.active=1 AND c.status='ACTIVE'").bind(body.mappingId).first<Record<string,unknown>>(),dates=datesBetween(body.startDate,(()=>{const end=new Date(`${body.endDate}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);return end.toISOString().slice(0,10)})());if(!mapping||!dates.length)return Response.json({error:"활성 매핑과 올바른 ARI 일자 범위를 선택하세요."},{status:400});const physicalRow=await db.prepare("SELECT COUNT(*) count,MAX(rt.base_rate) base_rate FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.property_id='prop-seoul' AND r.room_type_id=? AND r.active=1 AND r.housekeeping_status<>'OUT_OF_SERVICE'").bind(mapping.room_type_id).first<{count:number;base_rate:number}>(),statements:D1PreparedStatement[]=[];
      for(const stayDate of dates){const [control,booked,held,prior]=await Promise.all([db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(mapping.room_type_id,stayDate).first<Record<string,unknown>>(),db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(mapping.room_type_id,stayDate).first<{count:number}>(),db.prepare("SELECT COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id WHERE bi.property_id='prop-seoul' AND bi.room_type_id=? AND bi.stay_date=? AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')").bind(mapping.room_type_id,stayDate).first<{count:number}>(),db.prepare("SELECT COALESCE(MAX(revision),0)+1 revision FROM ari_updates WHERE mapping_id=? AND property_id='prop-seoul' AND stay_date=?").bind(mapping.id,stayDate).first<{revision:number}>()]);const sellLimit=control?.sell_limit==null?Number(physicalRow?.count??0):Number(control.sell_limit),available=Boolean(control?.closed)?0:Math.max(0,sellLimit-Number(booked?.count??0)-Number(held?.count??0)),revision=Number(prior?.revision??1),payload={roomstosell:available,closed:Boolean(control?.closed),minimumstay:Number(control?.min_stay??1),closedonarrival:Boolean(control?.close_to_arrival),closedondeparture:Boolean(control?.close_to_departure),rate:Number(control?.price_override??physicalRow?.base_rate??0),currency:"KRW",date:stayDate};const ariId=crypto.randomUUID();statements.push(db.prepare("INSERT INTO ari_updates VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 'PENDING', 0, ?, NULL, NULL)").bind(ariId,mapping.connection_id,mapping.id,stayDate,revision,available,payload.closed?1:0,payload.minimumstay,payload.closedonarrival?1:0,payload.closedondeparture?1:0,payload.rate,JSON.stringify(payload),now));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'channel.ari_delta', 'ari_update', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),ariId,JSON.stringify(payload),now));}
      await db.batch(statements);
    } else if (body.action === "dispatch_ari_update") {
      const update=await db.prepare("SELECT a.*,c.provider FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id WHERE a.id=? AND a.property_id='prop-seoul' AND c.property_id='prop-seoul' AND a.status IN ('PENDING','FAILED')").bind(body.updateId).first<Record<string,unknown>>();if(!update)return Response.json({error:"전송 또는 재처리 가능한 ARI 업데이트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(update.attempts)+1;await db.batch([db.prepare("UPDATE ari_updates SET status=?,attempts=?,sent_at=?,last_error=? WHERE id=? AND property_id='prop-seoul'").bind(failed?"FAILED":"SENT",attempt,failed?null:now,failed?"SANDBOX_TIMEOUT":null,update.id),db.prepare("UPDATE channel_connections SET last_sync_at=CASE WHEN ?=1 THEN last_sync_at ELSE ? END,updated_at=? WHERE id=? AND property_id='prop-seoul'").bind(failed?1:0,now,now,update.connection_id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'OUTBOUND', ?, 'ari_update', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),update.provider,update.id,attempt,failed?"FAILED":"ACKED",failed?504:200,failed?"TIMEOUT":null,failed?"Sandbox timeout":null,update.payload_json,now,actor)]);
    } else if (body.action === "ingest_channel_message") {
      const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND property_id='prop-seoul' AND status='ACTIVE'").bind(body.connectionId).first<Record<string,unknown>>();if(!connection)return Response.json({error:"활성 채널 연결을 선택하세요."},{status:400});const duplicate=await db.prepare("SELECT id FROM inbound_channel_messages WHERE connection_id=? AND message_id=? AND property_id='prop-seoul'").bind(body.connectionId,body.messageId).first();if(duplicate)return Response.json(await snapshot(db,principal),{headers:{"X-Channel-Duplicate":"true"}});
      const payload:ChannelPayload={connectionId:body.connectionId,messageId:body.messageId,eventType:body.eventType,externalReservationId:body.externalReservationId,revision:Number(body.revision),externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId,firstName:body.firstName,lastName:body.lastName,email:body.email,arrivalDate:body.arrivalDate,departureDate:body.departureDate,adults:Number(body.adults),children:Number(body.children),nightlyRate:Number(body.nightlyRate),currency:body.currency||"KRW"},messageId=crypto.randomUUID();await db.prepare("INSERT INTO inbound_channel_messages VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, NULL, ?, NULL)").bind(messageId,body.connectionId,connection.provider,body.messageId,body.eventType.toUpperCase(),body.externalReservationId,Number(body.revision),JSON.stringify(payload),now).run();const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=? AND property_id='prop-seoul'").bind(messageId).first<Record<string,unknown>>();
      try{await processChannelMessage(db,message!,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error);await db.batch([db.prepare("UPDATE inbound_channel_messages SET status='FAILED',attempts=attempts+1,last_error=? WHERE id=? AND property_id='prop-seoul'").bind(detail,messageId),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, 1, 'FAILED', 409, 'PROCESSING_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,messageId,detail,JSON.stringify(payload),now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId,status:"FAILED"},{status:409});}
    } else if (body.action === "replay_channel_message") {
      const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=? AND property_id='prop-seoul' AND status='FAILED'").bind(body.messageId).first<Record<string,unknown>>();if(!message)return Response.json({error:"DLQ에서 재처리할 메시지를 찾지 못했습니다."},{status:409});const payload=JSON.parse(String(message.payload_json)) as ChannelPayload;try{await processChannelMessage(db,message,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error),attempt=Number(message.attempts)+1;await db.batch([db.prepare("UPDATE inbound_channel_messages SET attempts=?,last_error=? WHERE id=? AND property_id='prop-seoul'").bind(attempt,detail,message.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, ?, 'FAILED', 409, 'REPLAY_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),message.provider,message.id,attempt,detail,message.payload_json,now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId:message.id,status:"FAILED"},{status:409});}
    } else if (body.action === "dispatch_outbox_event") {
      const event=await db.prepare("SELECT * FROM outbox_events WHERE id=? AND property_id='prop-seoul' AND status IN ('PENDING','FAILED')").bind(body.eventId).first<Record<string,unknown>>();if(!event)return Response.json({error:"전송 또는 재처리 가능한 outbox 이벤트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(event.attempts)+1,provider=body.provider||"WEBHOOK";await db.batch([db.prepare("UPDATE outbox_events SET status=?,attempts=?,published_at=? WHERE id=? AND property_id='prop-seoul'").bind(failed?"FAILED":"PUBLISHED",attempt,failed?null:now,event.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'OUTBOUND', ?, 'outbox_event', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),provider,event.id,attempt,failed?"FAILED":"ACKED",failed?503:200,failed?"UNAVAILABLE":null,failed?"Sandbox endpoint unavailable":null,event.payload_json,now,actor)]);
    } else if (body.action === "open_cashier") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>();
      const openingAmount = Number(body.openingAmount || 0); if (!Number.isFinite(openingAmount) || openingAmount < 0) return Response.json({error:"시재금은 0원 이상이어야 합니다."},{status:400});
      const existing = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (existing) return Response.json({error:"이미 개시된 캐셔 세션이 있습니다."},{status:409});
      const cashierId = crypto.randomUUID(); const statements = [
        db.prepare("INSERT INTO cashier_sessions VALUES (?, 'prop-seoul', ?, ?, 'OPEN', ?, NULL, NULL, NULL, ?, NULL)").bind(cashierId,actor,property?.business_date,openingAmount,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'OPEN_CASHIER', 'cashier_session', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,cashierId,JSON.stringify({openingAmount,businessDate:property?.business_date}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "close_cashier") {
      const session = await db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first<Record<string,unknown>>();
      if (!session) return Response.json({error:"개시된 캐셔 세션이 없습니다."},{status:409});
      const cash = await db.prepare("SELECT (SELECT COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind IN ('PAYMENT_REVERSAL','REFUND') THEN -amount ELSE 0 END),0) FROM folio_entries WHERE property_id='prop-seoul' AND business_date=? AND created_by=? AND payment_method='CASH')+(SELECT COALESCE(SUM(credit),0) FROM ar_ledger_entries WHERE property_id='prop-seoul' AND business_date=? AND created_by=? AND kind='PAYMENT' AND payment_method='CASH') total").bind(session.business_date,actor,session.business_date,actor).first<{total:number}>();
      const expected = Number(session.opening_amount)+Number(cash?.total??0), counted=Number(body.countedAmount);
      if (!Number.isFinite(counted) || counted < 0) return Response.json({error:"실사 현금을 올바르게 입력하세요."},{status:400});
      const variance = counted-expected; const statements = [
        db.prepare("UPDATE cashier_sessions SET status='CLOSED', expected_amount=?, counted_amount=?, variance=?, closed_at=? WHERE id=? AND property_id='prop-seoul' AND status='OPEN'").bind(expected,counted,variance,now,session.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_CASHIER', 'cashier_session', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,session.id,JSON.stringify(session),JSON.stringify({status:"CLOSED",expected,counted,variance}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "run_night_audit") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(property?.business_date);
      const controls = await operationalControls(db,businessDate,actor);
      if (!controls.canClose) return Response.json({error:"영업일 마감 선행조건이 충족되지 않았습니다.",blockers:controls.blockers},{status:409});
      const stays = await db.prepare("SELECT r.id, r.room_id, COALESCE((SELECT rr.sell_rate FROM reservation_rate_nights rr WHERE rr.reservation_id=r.id AND rr.stay_date=?),r.nightly_rate) nightly_rate FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate,businessDate).all<{id:string;room_id:string;nightly_rate:number}>();
      const cutoffBlocks=await db.prepare("SELECT id FROM business_blocks WHERE property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE') AND cutoff_date IS NOT NULL AND cutoff_date<=?").bind(businessDate).all<{id:string}>();
      const next = new Date(`${businessDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1); const nextDate=next.toISOString().slice(0,10); const auditId=crypto.randomUUID();
      const statements = [db.prepare("INSERT INTO night_audits VALUES (?, 'prop-seoul', ?, 'COMPLETED', '[]', ?, ?, ?, ?)").bind(auditId,businessDate,JSON.stringify({roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length,nextBusinessDate:nextDate}),now,now,actor)];
      for (const stay of stays.results) {
        const entryId=crypto.randomUUID(),parts=inclusiveComponents(Number(stay.nightly_rate),0.10,0);
        statements.push(db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', 'ROOM', '객실료 자동 전기', ?, NULL, ?, ?, 'night-audit', NULL)").bind(entryId,stay.id,parts.total,businessDate,now));
        statements.push(db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,stay.id,`fw-${stay.id}`,parts.net,parts.tax,parts.service,now));
        if (stay.room_id) statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 2, NULL, '스테이오버 객실', ?)").bind(crypto.randomUUID(),stay.room_id,nextDate,now));
      }
      for(const block of cutoffBlocks.results){statements.push(db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=? AND property_id='prop-seoul'").bind(now,block.id));statements.push(db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul'").bind(now,now,block.id));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),block.id,JSON.stringify({blockId:block.id,automatic:true,businessDate}),now));}
      statements.push(db.prepare("UPDATE properties SET business_date=? WHERE id='prop-seoul' AND business_date=?").bind(nextDate,businessDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_BUSINESS_DATE', 'night_audit', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,auditId,JSON.stringify({businessDate}),JSON.stringify({nextDate,roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'business_date.closed', 'night_audit', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),auditId,JSON.stringify({businessDate,nextDate}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "mark_no_show" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 노쇼 처리할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 노쇼 처리할 수 없습니다."},{status:409});
      const statements = [
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'NO_SHOW', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='NO_SHOW', version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN'").bind(now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MARK_NO_SHOW', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"NO_SHOW"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.no_show', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 체크인할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 체크인할 수 없습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"객실 배정이 필요합니다."},{status:409});
      const room = await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(reservation.room_id).first<Record<string, unknown>>();
      if (!room || !["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"청소 완료 또는 점검 완료 객실만 체크인할 수 있습니다."},{status:409});
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'IN_HOUSE', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='IN_HOUSE', version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN'").bind(now, body.reservationId),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND property_id='prop-seoul'").bind(reservation.room_id),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_IN","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"IN_HOUSE"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_in', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "check_out" && reservation) {
      if (reservation.status !== "IN_HOUSE") return Response.json({error:"투숙 중 예약만 체크아웃할 수 있습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"예약에 배정된 객실이 없습니다."},{status:409});
      const bal = await db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) balance FROM folio_entries WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId).first<{balance:number}>();
      if (Math.abs(bal?.balance ?? 0) > .01) return Response.json({error:"잔액을 정산한 뒤 체크아웃하세요."},{status:409});
      const task = crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'IN_HOUSE', 'CHECKED_OUT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CHECKED_OUT', departure_date=CASE WHEN departure_date>? THEN ? ELSE departure_date END, version=version+1, updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='IN_HOUSE'").bind(businessDate,businessDate,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul' AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul' AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=? AND property_id='prop-seoul'").bind(reservation.room_id),
        db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, 'PENDING', 1, NULL, '체크아웃 객실', ?)").bind(task,"prop-seoul",reservation.room_id,businessDate,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_OUT","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CHECKED_OUT"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_out', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_payment" && reservation) {
      const amount = Number(body.amount); if (!(amount > 0)) return Response.json({error:"결제 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"결제 전 캐셔 세션을 개시하세요."},{status:409});
      const windowId=await folioWindowFor(db,body.reservationId,"PAYMENT",body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, 'PAYMENT', 'PAYMENT', '프런트 결제', ?, ?, ?, ?, ?, NULL)").bind(entryId,"prop-seoul",body.reservationId,amount,body.method || "CARD",businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,amount,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.payment_posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,method:body.method||"CARD"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_charge" && reservation) {
      const amount=Number(body.amount); if(!(amount>0)) return Response.json({error:"전기 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"비용 전기 전 캐셔 세션을 개시하세요."},{status:409});
      const code=(body.code||"MISC").toUpperCase(),transactionCode=await db.prepare("SELECT * FROM transaction_codes WHERE property_id='prop-seoul' AND code=? AND active=1").bind(code).first<Record<string,unknown>>();
      if(!transactionCode)return Response.json({error:"활성 거래 코드를 선택하세요."},{status:400});
      const parts=inclusiveComponents(amount,Number(transactionCode.tax_rate),Number(transactionCode.service_rate)),windowId=await folioWindowFor(db,body.reservationId,code,body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(entryId,body.reservationId,code,body.description||String(transactionCode.name),parts.total,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,parts.net,parts.tax,parts.service,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,kind:"CHARGE"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "create_folio_window" && reservation) {
      const next=await db.prepare("SELECT COALESCE(MAX(window_no),0)+1 next_no FROM folio_windows WHERE reservation_id=? AND property_id='prop-seoul'").bind(body.reservationId).first<{next_no:number}>(),windowId=crypto.randomUUID(),payeeType=body.payeeType||"GUEST";
      if(!["GUEST","COMPANY","TRAVEL_AGENT","GROUP"].includes(payeeType))return Response.json({error:"올바른 지불 주체 유형을 선택하세요."},{status:400});
      if(body.accountProfileId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.accountProfileId).first())return Response.json({error:"유효한 계정 프로필을 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL)").bind(windowId,body.reservationId,Number(next?.next_no??1),body.name?.trim()||`Window ${next?.next_no??1}`,payeeType,body.accountProfileId||null,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_FOLIO_WINDOW', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({windowId,payeeType}),now),mutationReceipt()]);
    } else if (body.action === "create_routing_rule" && reservation) {
      const code=(body.code||"").toUpperCase(),target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id='prop-seoul' AND status='OPEN'").bind(body.windowId,body.reservationId).first(); if(!code||!target)return Response.json({error:"거래 코드와 열린 대상 폴리오를 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_routing_rules VALUES (?, 'prop-seoul', ?, ?, ?, 1, ?, ?) ON CONFLICT(reservation_id,transaction_code) DO UPDATE SET target_window_id=excluded.target_window_id,active=1").bind(crypto.randomUUID(),body.reservationId,code,body.windowId,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPSERT_FOLIO_ROUTING', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({code,windowId:body.windowId}),now),mutationReceipt()]);
    } else if (body.action === "split_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id='prop-seoul' AND x.kind='CHARGE_REVERSAL'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id='prop-seoul' AND d.property_id='prop-seoul' AND f.kind='CHARGE'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount));
      if(!source||!(amount>0)||amount>Number(source.remaining)+0.001)return Response.json({error:"분할 가능한 원전표 잔액 안에서 금액을 입력하세요."},{status:409});
      const target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id='prop-seoul' AND status='OPEN'").bind(body.targetWindowId,source.reservation_id).first(); if(!target||body.targetWindowId===source.folio_window_id)return Response.json({error:"다른 열린 폴리오 창을 선택하세요."},{status:400});
      const ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),reverseId=crypto.randomUUID(),repostId=crypto.randomUUID(),reason=body.reason?.trim()||"FOLIO_SPLIT";
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE_REVERSAL', ?, ?, ?, NULL, ?, ?, ?, ?)").bind(reverseId,source.reservation_id,source.code,`분할 반대전표 · ${source.description}`,amount,businessDate,now,actor,source.id),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(reverseId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(repostId,source.reservation_id,source.code,`분할 전기 · ${source.description}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(repostId,source.reservation_id,body.targetWindowId,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'SPLIT_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({amount,targetWindowId:body.targetWindowId,reverseId,repostId,reason}),now),
        mutationReceipt(),
      ]);
    } else if (body.action === "reverse_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id='prop-seoul' AND x.kind=CASE f.kind WHEN 'CHARGE' THEN 'CHARGE_REVERSAL' ELSE 'PAYMENT_REVERSAL' END),0)-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id='prop-seoul' AND x.kind='REFUND'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id='prop-seoul' AND d.property_id='prop-seoul' AND f.kind IN ('CHARGE','PAYMENT')").bind(body.entryId).first<Record<string,unknown>>();
      if(!source||Number(source.remaining)<=0.001)return Response.json({error:"이미 전액 반대전표 처리된 전표입니다."},{status:409}); const reason=body.reason?.trim();if(!reason)return Response.json({error:"정정 사유를 입력하세요."},{status:400});
      const amount=roundMoney(Number(source.remaining)),ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),entryId=crypto.randomUUID(),kind=source.kind==='CHARGE'?'CHARGE_REVERSAL':'PAYMENT_REVERSAL';
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,kind,source.code,`반대전표 · ${source.description}`,amount,source.payment_method??null,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'REVERSE_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({entryId,kind,amount,reason}),now),mutationReceipt()]);
    } else if (body.action === "refund_payment") {
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"환불 전 캐셔 세션을 개시하세요."},{status:409});
      const source=await db.prepare("SELECT f.*,d.folio_window_id,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id='prop-seoul' AND x.kind IN ('PAYMENT_REVERSAL','REFUND')),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id='prop-seoul' AND d.property_id='prop-seoul' AND f.kind='PAYMENT'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),reason=body.reason?.trim();
      if(!source||source.payment_method==='DIRECT_BILL'||!(amount>0)||amount>Number(source.remaining)+0.001||!reason)return Response.json({error:"환불 가능 결제와 잔액, 사유를 확인하세요."},{status:409}); const entryId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'REFUND', 'REFUND', ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,`환불 · ${reason}`,amount,source.payment_method,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,amount,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'REFUND_PAYMENT', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({entryId,amount,reason}),now),mutationReceipt()]);
    } else if (body.action === "transfer_to_ar") {
      const window=await db.prepare(`SELECT w.*,r.id reservation_id,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id AND r.property_id=w.property_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id AND d.property_id=w.property_id LEFT JOIN folio_entries f ON f.id=d.entry_id AND f.property_id=w.property_id WHERE w.id=? AND w.property_id='prop-seoul' AND w.status='OPEN' GROUP BY w.id,r.id`).bind(body.windowId).first<Record<string,unknown>>(),profile=await db.prepare("SELECT * FROM account_profiles WHERE id=? AND property_id='prop-seoul' AND active=1 AND credit_status='DIRECT_BILL'").bind(body.accountProfileId).first<Record<string,unknown>>();
      if(!window||Number(window.balance)<=0.001||!profile)return Response.json({error:"잔액이 있는 열린 폴리오와 후불 승인 계정을 선택하세요."},{status:409}); const dueDate=body.dueDate;if(!dueDate||dueDate<businessDate)return Response.json({error:"청구서 만기일을 확인하세요."},{status:400});
      const arAccountId=`ar-${profile.id}`,existingAccount=await db.prepare("SELECT credit_limit FROM ar_accounts WHERE id=? AND property_id='prop-seoul'").bind(arAccountId).first<{credit_limit:number}>(),accountBalance=await db.prepare("SELECT COALESCE(SUM(debit-credit),0) balance FROM ar_ledger_entries WHERE ar_account_id=? AND property_id='prop-seoul'").bind(arAccountId).first<{balance:number}>(),creditLimit=existingAccount?Number(existingAccount.credit_limit):Number(body.creditLimit||0),amount=roundMoney(Number(window.balance));if(creditLimit>0&&Number(accountBalance?.balance??0)+amount>creditLimit)return Response.json({error:"AR 신용 한도를 초과합니다."},{status:409});
      const base=Number(window.net_total)+Number(window.tax_total)+Number(window.service_total),ratio=base>0?amount/base:1,subtotal=roundMoney(Number(window.net_total)*ratio),tax=roundMoney(Number(window.tax_total)*ratio),service=roundMoney(amount-subtotal-tax),invoiceId=crypto.randomUUID(),paymentId=crypto.randomUUID(),invoiceNo=`AR-${businessDate.replaceAll('-','')}-${Math.floor(1000+Math.random()*9000)}`;
      await db.batch([
        db.prepare("INSERT INTO ar_accounts VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT DO NOTHING").bind(arAccountId,profile.id,String(profile.external_id||profile.id),String(profile.name),creditLimit,now,now),
        db.prepare("INSERT INTO ar_invoices VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)").bind(invoiceId,arAccountId,window.reservation_id,window.id,invoiceNo,businessDate,dueDate,subtotal,tax,service,amount,now,actor),
        db.prepare("INSERT INTO ar_ledger_entries VALUES (?, 'prop-seoul', ?, ?, 'INVOICE', ?, 0, ?, NULL, ?, ?, ?, NULL)").bind(crypto.randomUUID(),arAccountId,invoiceId,amount,businessDate,`Folio transfer ${invoiceNo}`,now,actor),
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'PAYMENT', 'DIRECT_BILL', ?, ?, 'DIRECT_BILL', ?, ?, ?, NULL)").bind(paymentId,window.reservation_id,`AR 이관 · ${invoiceNo}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', NULL, ?, ?)").bind(paymentId,window.reservation_id,window.id,amount,`AR:${invoiceNo}`,now),
        db.prepare("UPDATE folio_windows SET status='TRANSFERRED',payee_type='COMPANY',payee_account_profile_id=?,closed_at=? WHERE id=? AND property_id='prop-seoul' AND status='OPEN'").bind(profile.id,now,window.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'TRANSFER_FOLIO_TO_AR', 'ar_invoice', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,invoiceId,JSON.stringify({invoiceNo,amount,windowId:window.id,accountProfileId:profile.id}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'ar.invoice_issued', 'ar_invoice', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),invoiceId,JSON.stringify({invoiceId,invoiceNo,amount}),now),
        mutationReceipt(),
      ]);
    } else if (body.action === "post_ar_payment") {
      const invoice=await db.prepare("SELECT i.*,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id AND l.property_id=i.property_id WHERE i.id=? AND i.property_id='prop-seoul' GROUP BY i.id").bind(body.invoiceId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),method=body.method||"BANK_TRANSFER";if(!invoice||!(amount>0)||amount>Number(invoice.balance)+0.001)return Response.json({error:"AR 청구서 잔액 안에서 수납 금액을 입력하세요."},{status:409});
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"AR 수납 전 캐셔 세션을 개시하세요."},{status:409}); const paid=amount>=Number(invoice.balance)-0.001;
      await db.batch([db.prepare("INSERT INTO ar_ledger_entries VALUES (?, 'prop-seoul', ?, ?, 'PAYMENT', 0, ?, ?, ?, ?, ?, ?, NULL)").bind(crypto.randomUUID(),invoice.ar_account_id,invoice.id,amount,businessDate,method,`AR receipt ${invoice.invoice_no}`,now,actor),...(paid?[db.prepare("UPDATE ar_invoices SET status='PAID' WHERE id=? AND property_id='prop-seoul' AND status='OPEN'").bind(invoice.id)]:[]),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'POST_AR_PAYMENT', 'ar_invoice', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(invoice.id),JSON.stringify({balance:invoice.balance}),JSON.stringify({amount,method,status:paid?'PAID':'OPEN'}),now),mutationReceipt()]);
    } else if (body.action === "housekeeping") {
      const status = body.status === "INSPECTED" ? "INSPECTED" : "CLEAN";
      const room = await db.prepare("SELECT id FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(body.roomId).first();
      if (!room) return Response.json({error:"객실을 찾지 못했습니다."},{status:404});
      await db.batch([
        db.prepare("UPDATE rooms SET housekeeping_status=?, version=version+1 WHERE id=? AND property_id='prop-seoul'").bind(status,body.roomId),
        db.prepare("UPDATE housekeeping_tasks SET status='DONE', updated_at=? WHERE room_id=? AND business_date=? AND property_id='prop-seoul'").bind(now,body.roomId,businessDate),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"HOUSEKEEPING_COMPLETE","room",body.roomId,JSON.stringify({housekeepingStatus:status}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else return Response.json({error:"지원하지 않는 작업입니다."},{status:400});
    invalidateSnapshots();
    return Response.json(await snapshot(db, principal));
  } catch (error) {
    const message=error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});
    if (message.includes("idempotency_keys_pkey") || message.includes("idempotency_keys.key")) return Response.json(await cachedSnapshot(db, principal), {headers:{"X-Idempotent-Replay":"true"}});
    if (message.includes("room_number_uq") || message.includes("rooms.property_id")) return Response.json({error:"다른 작업자가 같은 객실 번호를 먼저 생성했습니다. 객실 목록을 새로고침해 주세요."},{status:409});
    if (message.includes("room_type_code_uq") || message.includes("room_types.property_id")) return Response.json({error:"이미 사용 중인 객실 타입 코드입니다."},{status:409});
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
    if (message.includes("invalid folio window")) return Response.json({error:"열린 폴리오 창을 찾지 못했습니다."},{status:409});
    if (message.includes("invalid folio entry") || message.includes("invalid folio detail")) return Response.json({error:"전표 금액·세금 구성 또는 대상 폴리오가 올바르지 않습니다."},{status:409});
    if (message.includes("folio_window_reservation_no_uq")) return Response.json({error:"다른 작업자가 같은 폴리오 창 번호를 먼저 만들었습니다."},{status:409});
    if (message.includes("ar_invoice_no_uq")) return Response.json({error:"청구서 번호가 충돌했습니다. 다시 시도하세요."},{status:409});
    if (message.includes("ar ledger entries are immutable") || message.includes("folio details are immutable")) return Response.json({error:"확정 원장은 수정·삭제할 수 없습니다. 반대전표를 사용하세요."},{status:409});
    if (message.includes("channel_connection_provider_property_uq") || message.includes("channel_connections.property_id")) return Response.json({error:"같은 채널과 외부 호텔 ID의 연결이 이미 있습니다."},{status:409});
    if (message.includes("channel_mapping_external_uq") || message.includes("channel_mappings.connection_id")) return Response.json({error:"같은 외부 객실·요금 매핑이 이미 있습니다."},{status:409});
    if (message.includes("stale channel revision")) return Response.json({error:"이미 처리한 revision보다 오래된 채널 메시지입니다."},{status:409});
    if (message.includes("integration attempts are immutable")) return Response.json({error:"연동 시도 원장은 수정·삭제할 수 없습니다."},{status:409});
    if (message.includes("pay or void accrued settlements")) return Response.json({error:"정산 대기 건을 입금·지급 완료 또는 무효 처리한 뒤 계약 유형과 수수료율을 변경하세요."},{status:409});
    if (message.includes("accounting journal lines are immutable") || message.includes("accounting journal entries are immutable")) return Response.json({error:"확정 회계 원장은 수정·삭제할 수 없습니다. 반대전표를 생성하세요."},{status:409});
    if (message.includes("accounting_journal_reversal_once_uq")) return Response.json({error:"다른 작업자가 이미 이 전표의 반대전표를 생성했습니다."},{status:409});
    if (message.includes("accounting_journal_source_once_uq")) return Response.json({error:"다른 작업자가 이미 이 정산 또는 회계 작업을 완료했습니다."},{status:409});
    const errorId=crypto.randomUUID();
    console.error("[AURORA_PMS_ERROR]",{errorId,action:body.action,actor,propertyId:principal.propertyId,error:error instanceof Error?error.name:"UnknownError",message});
    return Response.json({error:"처리 중 오류가 발생했습니다. 문제가 계속되면 오류 ID를 관리자에게 알려 주세요.",errorId},{status:500});
  }
}
