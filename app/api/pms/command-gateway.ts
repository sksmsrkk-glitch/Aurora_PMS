/** Authenticated PMS command gateway and domain-handler dispatcher. */
import { getPmsDatabase, scopePmsDatabase, type PmsDatabase, type PmsPreparedStatement } from "../../../db/pms-database";
import { schemaNotReadyResponse } from "../../../db/schema-contract";
import { consumeRateLimit, rateLimitHeaders } from "../rate-limit";
import { handleExtendedAction, PmsExtendedError } from "./extended";
import { ReportRequestError, runReport } from "./reporting";
import { principalAccessFailureResponse, principalFor, ready, runtimeBindings } from "./auth";
import { invalidateSnapshots } from "./read-model";
import { registrationFor, validationMessage } from "./action-registry";
import { mapPmsError } from "./error-map";
import { pmsMutationReceipt } from "../../pms-mutation";
import { buildAriDeltaInserts } from "./ari-delta";
import { addIsoDays } from "../../../lib/format";
import { handleStaffAction, StaffAccessError } from "./staff";
import { StaffAuthError } from "./staff-auth";

type D1=PmsDatabase;
type D1PreparedStatement=PmsPreparedStatement;
// postgres.js distinguishes structured values from strings when binding JSONB.
// Keeping this identity helper explicit prevents double-encoded JSON scalars.
const jsonb = <T,>(value:T) => value;

async function operationalControls(db: D1, businessDate: string, actor?: string) {
  // Keep the close-day guard below the six-connection serverless pool ceiling.
  // Seven independent parallel queries could occupy every connection while a
  // queued guard waited behind them; one snapshot is faster and consistent.
  const summary=await db.prepare("SELECT (SELECT COUNT(*) FROM reservations WHERE property_id=pms_current_property_id() AND arrival_date=? AND status='DUE_IN') arrivals,(SELECT COUNT(*) FROM cashier_sessions WHERE property_id=pms_current_property_id() AND business_date=? AND status='OPEN') cashiers,(SELECT COUNT(*) FROM rooms WHERE property_id=pms_current_property_id() AND housekeeping_status='OUT_OF_SERVICE') oos,(SELECT COUNT(*) FROM outbox_events WHERE property_id=pms_current_property_id() AND status='FAILED') failed,(SELECT COUNT(*) FROM night_audits WHERE property_id=pms_current_property_id() AND business_date=?) prior_audits,(SELECT COUNT(*) FROM reservations r WHERE r.property_id=pms_current_property_id() AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')) room_postings").bind(businessDate,businessDate,businessDate,businessDate,businessDate,businessDate).first<{arrivals:number;cashiers:number;oos:number;failed:number;prior_audits:number;room_postings:number}>();
  const openCashier=actor?await db.prepare("SELECT * FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first():null;
  const priorAudit=Number(summary?.prior_audits??0)>0?await db.prepare("SELECT * FROM night_audits WHERE property_id=pms_current_property_id() AND business_date=? LIMIT 1").bind(businessDate).first():null;
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
  if(explicit){const row=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(explicit,reservationId).first<{id:string}>();if(row)return row.id;throw new Error("invalid folio window");}
  const routed=await db.prepare("SELECT w.id FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id WHERE rr.reservation_id=? AND rr.transaction_code=? AND rr.property_id=pms_current_property_id() AND w.property_id=pms_current_property_id() AND rr.active AND w.status='OPEN' LIMIT 1").bind(reservationId,code).first<{id:string}>(); if(routed)return routed.id;
  const base=await db.prepare("SELECT id FROM folio_windows WHERE reservation_id=? AND property_id=pms_current_property_id() AND status='OPEN' ORDER BY window_no LIMIT 1").bind(reservationId).first<{id:string}>(); if(!base)throw new Error("invalid folio window"); return base.id;
}

type ChannelPayload={connectionId:string;messageId:string;eventType:string;externalReservationId:string;revision:number;externalRoomTypeId?:string;externalRatePlanId?:string;firstName?:string;lastName?:string;email?:string;arrivalDate?:string;departureDate?:string;adults?:number;children?:number;nightlyRate?:number;currency?:string};
async function processChannelMessage(db:D1,message:Record<string,unknown>,payload:ChannelPayload,actor:string,now:string) {
  // Provider revisions must increase monotonically per external reservation. The
  // reservation mutation, inventory-night replacement, link revision, delivery
  // receipt, audit log, and outbox event commit together to make retries observable
  // without applying an old OTA message over newer hotel state.
  const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND property_id=pms_current_property_id() AND status='ACTIVE'").bind(payload.connectionId).first<Record<string,unknown>>();if(!connection)throw new Error("channel connection unavailable");
  const link=await db.prepare("SELECT * FROM channel_reservation_links WHERE connection_id=? AND external_reservation_id=? AND property_id=pms_current_property_id()").bind(payload.connectionId,payload.externalReservationId).first<Record<string,unknown>>();
  const revision=Number(payload.revision),attemptNo=Number(message.attempts??0)+1,eventType=payload.eventType.toUpperCase();if(!Number.isInteger(revision)||revision<1)throw new Error("invalid channel revision");if(link&&revision<=Number(link.last_revision))throw new Error("stale channel revision");
  const statements:D1PreparedStatement[]=[];let reservationId=String(link?.reservation_id??"");
  if(eventType==="NEW"){
    if(link)throw new Error("channel reservation already linked");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND property_id=pms_current_property_id() AND active").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping)throw new Error("channel mapping unavailable");
    if(!payload.firstName?.trim()||!payload.lastName?.trim()||!payload.arrivalDate||!payload.departureDate)throw new Error("invalid channel reservation");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);
    const guestId=crypto.randomUUID();reservationId=crypto.randomUUID();const confirmation=`OTA-${String(connection.provider).slice(0,3).toUpperCase()}-${Math.floor(100000+Math.random()*900000)}`,nightlyRate=Number(payload.nightlyRate);if(!(nightlyRate>=0))throw new Error("invalid channel reservation");
    statements.push(db.prepare("INSERT INTO guests VALUES (?, pms_current_property_id(), ?, ?, ?, NULL, 'NONE', NULL, '[]', ?)").bind(guestId,payload.firstName.trim(),payload.lastName.trim(),payload.email||null,now));
    statements.push(db.prepare("INSERT INTO reservations VALUES (?, ?, pms_current_property_id(), ?, ?, NULL, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||1,Number(payload.children)||0,String(connection.provider),String(mapping.rate_plan),nightlyRate,`Channel ${payload.externalReservationId} · revision ${revision}`,now,now));
    statements.push(db.prepare("INSERT INTO folio_windows VALUES (?, pms_current_property_id(), ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("INSERT INTO channel_reservation_links VALUES (?, pms_current_property_id(), ?, ?, ?, ?, 'ACTIVE', ?, ?)").bind(crypto.randomUUID(),payload.connectionId,payload.externalReservationId,reservationId,revision,now,now));
  } else if(eventType==="MODIFY"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN'").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be modified");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND property_id=pms_current_property_id() AND active").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping||!payload.arrivalDate||!payload.departureDate)throw new Error("channel mapping unavailable");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);reservationId=String(link.reservation_id);
    statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, pms_current_property_id(), ?, ?, 'CHANNEL_MODIFY', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(reservationId));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("UPDATE reservations SET room_type_id=?,room_id=NULL,arrival_date=?,departure_date=?,adults=?,children=?,nightly_rate=?,notes=?,version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||Number(reservation.adults),Number(payload.children)||0,Number(payload.nightlyRate)||Number(reservation.nightly_rate),`Channel ${payload.externalReservationId} · revision ${revision}`,now,reservationId,Number(reservation.version)));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,updated_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(revision,now,link.id));
  } else if(eventType==="CANCEL"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id=pms_current_property_id() AND status NOT IN ('CANCELLED','CHECKED_OUT')").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be cancelled");reservationId=String(link.reservation_id);statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, pms_current_property_id(), ?, ?, 'CHANNEL_CANCEL', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("UPDATE reservations SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(now,reservationId,Number(reservation.version)));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(reservationId));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,status='CANCELLED',updated_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(revision,now,link.id));
  } else throw new Error("unsupported channel event");
  statements.push(db.prepare("UPDATE inbound_channel_messages SET status='PROCESSED',attempts=?,reservation_id=?,last_error=NULL,processed_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(attemptNo,reservationId,now,message.id));statements.push(db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, pms_current_property_id(), 'INBOUND', ?, 'channel_message', ?, ?, 'ACKED', 200, NULL, NULL, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,message.id,attemptNo,jsonb(payload),now,actor));statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, ?, 'channel_reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,`CHANNEL_${eventType}`,reservationId,jsonb({externalReservationId:payload.externalReservationId,revision,messageId:payload.messageId}),now));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), ?, 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),`channel.reservation_${eventType.toLowerCase()}`,reservationId,jsonb({reservationId,externalReservationId:payload.externalReservationId,revision}),now));await db.batch(statements);return reservationId;
}

async function stayControlError(db:D1, roomTypeId:string, arrival:string, departure:string) {
  const nights=datesBetween(arrival,departure); if (!nights.length) return "올바른 숙박 일정을 입력하세요.";
  const controls=await db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND room_type_id=? AND stay_date BETWEEN ? AND ?").bind(roomTypeId,arrival,departure).all<Record<string,unknown>>();
  const arrivalControl=controls.results.find(row=>row.stay_date===arrival), departureControl=controls.results.find(row=>row.stay_date===departure);
  if (arrivalControl?.close_to_arrival) return "선택한 도착일은 체크인 제한(CTA)이 설정되어 있습니다.";
  if (departureControl?.close_to_departure) return "선택한 출발일은 체크아웃 제한(CTD)이 설정되어 있습니다.";
  const minimum=Math.max(1,...controls.results.filter(row=>nights.includes(String(row.stay_date))).map(row=>Number(row.min_stay??1)));
  if (nights.length<minimum) return `최소 ${minimum}박 이상 예약해야 합니다.`;
  return null;
}

/** Fast UX precheck; the database trigger remains the concurrency-safe source
 * of truth when two administrators create rooms at the same time. */
async function roomLimitExceeded(db:D1,additionalRooms:number){
  const usage=await db.prepare("SELECT s.room_limit,(SELECT COUNT(*) FROM rooms r WHERE r.property_id=pms_current_property_id() AND r.active) active_rooms FROM property_subscriptions s WHERE s.property_id=pms_current_property_id() LIMIT 1").first<{room_limit:number|null;active_rooms:number}>();
  return usage?.room_limit!=null&&Number(usage.active_rooms)+additionalRooms>Number(usage.room_limit);
}


export async function handlePmsPost(request: Request) {
  // Mutation pipeline order is security-sensitive: authenticate, reject cross-origin
  // requests, scope the database, authorize the action capability, validate the
  // idempotency key, then execute the command and invalidate read caches.
  const rootDb = getPmsDatabase(runtimeBindings);
  try { await ready(rootDb); } catch (error) { const response=schemaNotReadyResponse(error); if(response)return response; throw error; }
  const principal = await principalFor(request, rootDb);
  if(principal?.mustChangePassword)return Response.json({error:"임시 비밀번호를 먼저 변경해 주세요.",code:"PASSWORD_CHANGE_REQUIRED"},{status:428});
  if (!principal) return principalAccessFailureResponse(request);
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"허용되지 않은 요청 출처입니다."},{status:403});
  let rateLimit;
  try { rateLimit=await consumeRateLimit(request,"pms-write",120,60_000,`${principal.propertyId}:${principal.email}`,rootDb); }
  catch { return Response.json({error:"요청 보호 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."},{status:503,headers:{"Retry-After":"30"}}); }
  if(!rateLimit.allowed)return Response.json({error:"변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."},{status:429,headers:rateLimitHeaders(rateLimit)});
  const db = scopePmsDatabase(rootDb, principal.propertyId);
  let rawBody: unknown;
  try { rawBody = await request.json(); }
  catch { return Response.json({error:"요청 본문이 올바른 JSON이 아닙니다."},{status:400}); }
  const rawAction=typeof rawBody==="object"&&rawBody!==null?"action" in rawBody?(rawBody as {action?:unknown}).action:undefined:undefined;
  const registration=registrationFor(rawAction);
  if(!registration||!principal.capabilities.includes(registration.capability))return Response.json({error:"이 작업을 수행할 권한이 없습니다."},{status:403});
  const parsed=registration.schema.safeParse(rawBody);
  if(!parsed.success)return Response.json({error:"요청 입력값을 확인하세요.",details:validationMessage(parsed.error)},{status:400});
  // Zod owns transport shape validation. Branch-local checks below are retained
  // only where live inventory, status, version, or accounting state is required.
  const body=parsed.data as Record<string,string>;
  const now = new Date().toISOString(); const actor = principal.email;
  if(principal.principalType==="SUPPORT"){
    if(!principal.supportGrantId||!principal.authUserId)return Response.json({error:"지원 세션이 만료되었습니다."},{status:403});
    const audited=await rootDb.recordSupportAccess({grantId:principal.supportGrantId,authUserId:principal.authUserId,actorEmail:principal.email,write:true,requestId:crypto.randomUUID(),action:body.action});
    if(!audited)return Response.json({error:"지원 권한이 만료되었거나 회수되었습니다."},{status:403});
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 200 || !/^[A-Za-z0-9:._-]+$/u.test(idempotencyKey)) return Response.json({error:"변경 요청에는 유효한 Idempotency-Key가 필요합니다."},{status:400});
  // Every successful mutation appends this strict unique receipt inside the same
  // transaction as its domain writes. Do not use OR IGNORE here: two concurrent
  // retries must make the losing transaction roll back all side effects.
  const mutationReceipt = () => db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now);
  const duplicate = await db.prepare("SELECT key FROM idempotency_keys WHERE key=? AND property_id=pms_current_property_id()").bind(idempotencyKey).first();
  if (duplicate && body.action!=="export_report") return Response.json(pmsMutationReceipt({action:body.action,domain:registration.domain,idempotencyKey,body,replayed:true}), {headers:{"X-Idempotent-Replay":"true"}});
  if(body.action==="export_report") {
    try {
      const params=new URLSearchParams();for(const key of ["report","q","from","to","status","source","roomTypeId"]){if(body[key])params.set(key,body[key]);}
      const report=await runReport(db,params,principal,{exportMode:true});
      if(duplicate)return Response.json({...report,replayed:true},{headers:{"X-Idempotent-Replay":"true"}});
      if(report.pagination.total>report.export.maxRows)return Response.json({error:`결과가 ${report.export.maxRows.toLocaleString()}행을 초과합니다. 기간 또는 필터를 좁혀 주세요.`},{status:413});
      const exportId=crypto.randomUUID(),filters=report.filters,format=body.format==="CSV"?"CSV":"XLSX";
      await db.batch([
        db.prepare("INSERT INTO report_exports VALUES (?, pms_current_property_id(), ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)").bind(exportId,report.report.key,format,filters,report.rows.length,actor,now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'EXPORT_REPORT', 'report_export', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,exportId,{report:report.report.key,filters,rowCount:report.rows.length,format},now),
        mutationReceipt(),
      ]);
      invalidateSnapshots();
      return Response.json({...report,exportId});
    } catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  const reservation = body.reservationId ? await db.prepare("SELECT * FROM reservations WHERE id=? AND property_id=pms_current_property_id()").bind(body.reservationId).first<Record<string, unknown>>() : null;
  const propertyState = await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>(); const businessDate=String(propertyState?.business_date);
  try {
    if(registration.domain==="users"){
      const handled=await handleStaffAction(db,body,principal,now,idempotencyKey);
      if(!handled)return Response.json({error:"지원하지 않는 직원 권한 작업입니다."},{status:400});
    } else if(registration.domain==="accounting"||registration.domain==="website"||(registration.domain==="inventory"&&["bulk_update_inventory_controls","upsert_rate_plan"].includes(body.action))||(registration.domain==="integrations"&&body.action==="upsert_channel_contract")) {
      const handled=await handleExtendedAction(db,body,principal,businessDate,now,idempotencyKey);
      if(!handled)return Response.json({error:"등록된 도메인 핸들러가 작업을 처리하지 못했습니다."},{status:500});
    } else if(body.action==="create_room_type") {
      const code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300);
      if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"타입 코드는 영문·숫자 2~12자, 이름은 2~80자, 기준 인원은 1~20명으로 입력하세요."},{status:400});
      const typeId=crypto.randomUUID();await db.batch([
        db.prepare("INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, true)").bind(typeId,code,name,baseRate,capacity,description),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_ROOM_TYPE', 'room_type', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,typeId,jsonb({code,name,baseRate,capacity,description,active:true}),now),
        ...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[]),
      ]);
    } else if(body.action==="update_room_type") {
      const current=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id=pms_current_property_id()").bind(body.roomTypeId).first<Record<string,unknown>>(),code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300),active=body.active!=="false";
      if(!current)return Response.json({error:"객실 타입을 찾지 못했습니다."},{status:404});if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"객실 타입 입력값을 확인하세요."},{status:400});
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실 타입을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      if(!active){const future=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE room_type_id=? AND property_id=pms_current_property_id() AND stay_date>=?").bind(body.roomTypeId,businessDate).first<{count:number}>();if(Number(future?.count||0)>0)return Response.json({error:"미래 예약이 있는 객실 타입은 비활성화할 수 없습니다."},{status:409});}
      await db.batch([db.prepare("UPDATE room_types SET code=?,name=?,base_rate=?,capacity=?,description=?,active=?,version=version+1 WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(code,name,baseRate,capacity,description,active,body.roomTypeId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'UPDATE_ROOM_TYPE', 'room_type', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomTypeId,jsonb(current),jsonb({code,name,baseRate,capacity,description,active,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="create_room") {
      if(await roomLimitExceeded(db,1))return Response.json({error:"현재 요금제의 활성 객실 수 한도를 초과합니다."},{status:409});
      const number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"활성 객실 타입, 16자 이하 객실번호, -10~250층을 입력하세요."},{status:400});const roomId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, pms_current_property_id(), ?, ?, ?, 'VACANT', 'CLEAN', ?, true, 1)").bind(roomId,body.roomTypeId,number,floor,jsonb(features)),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_ROOM', 'room', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,roomId,jsonb({number,floor,roomTypeId:body.roomTypeId,features}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="bulk_create_rooms") {
      const requestedRooms=Number(body.count);if(Number.isInteger(requestedRooms)&&requestedRooms>0&&await roomLimitExceeded(db,requestedRooms))return Response.json({error:"현재 요금제의 활성 객실 수 한도를 초과합니다."},{status:409});
      const start=Number(body.startNumber),count=Number(body.count),floor=Number(body.floor),padding=Math.min(8,Math.max(1,Number(body.padding)||String(body.startNumber||"").length)),prefix=(body.prefix||"").trim().toUpperCase().slice(0,8),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>500||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"시작 번호와 생성 수량(1~500), 층, 활성 객실 타입을 확인하세요."},{status:400});
      const numbers=Array.from({length:count},(_,index)=>`${prefix}${String(start+index).padStart(padding,"0")}`);if(numbers.some(number=>number.length>16))return Response.json({error:"생성되는 객실번호는 16자를 초과할 수 없습니다."},{status:400});const existing=await db.prepare("SELECT number FROM rooms WHERE property_id=pms_current_property_id()").all<{number:string}>(),known=new Set(existing.results.map(row=>row.number));const duplicate=numbers.find(number=>known.has(number));if(duplicate)return Response.json({error:`객실 ${duplicate}번이 이미 존재합니다.`},{status:409});
      const roomStatements=numbers.map(number=>db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, pms_current_property_id(), ?, ?, ?, 'VACANT', 'CLEAN', ?, true, 1)").bind(crypto.randomUUID(),body.roomTypeId,number,floor,jsonb(features)));
      await db.batch([...roomStatements,db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'BULK_CREATE_ROOMS', 'room_batch', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,crypto.randomUUID(),jsonb({roomTypeId:body.roomTypeId,prefix,start,count,floor,numbers}),now),db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]);
    } else if(body.action==="update_room") {
      const current=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id=pms_current_property_id()").bind(body.roomId).first<Record<string,unknown>>(),number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),active=body.active!=="false",type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!current)return Response.json({error:"객실을 찾지 못했습니다."},{status:404});if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"객실 입력값을 확인하세요."},{status:400});const changingType=String(current.room_type_id)!==body.roomTypeId,future=await db.prepare("SELECT COUNT(*) count FROM reservation_nights WHERE room_id=? AND property_id=pms_current_property_id() AND stay_date>=?").bind(body.roomId,businessDate).first<{count:number}>();if((changingType||!active)&&Number(future?.count||0)>0)return Response.json({error:"미래 예약이 배정된 객실은 타입 변경 또는 비활성화할 수 없습니다."},{status:409});if(!active&&current.front_desk_status==="OCCUPIED")return Response.json({error:"투숙 중인 객실은 비활성화할 수 없습니다."},{status:409});const housekeeping=active?(current.housekeeping_status==="OUT_OF_SERVICE"?"CLEAN":String(current.housekeeping_status)):"OUT_OF_SERVICE";
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      await db.batch([db.prepare("UPDATE rooms SET room_type_id=?,number=?,floor=?,features=?,active=?,housekeeping_status=?,version=version+1 WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(body.roomTypeId,number,floor,jsonb(features),active,housekeeping,body.roomId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'UPDATE_ROOM', 'room', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomId,jsonb(current),jsonb({roomTypeId:body.roomTypeId,number,floor,features,active,housekeeping,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if (body.action === "create_reservation") {
      const arrival = new Date(`${body.arrivalDate}T00:00:00Z`), departure = new Date(`${body.departureDate}T00:00:00Z`);
      if (!body.firstName?.trim() || !body.lastName?.trim() || !Number.isFinite(arrival.valueOf()) || departure <= arrival) return Response.json({error:"고객명과 올바른 숙박 일정을 입력하세요."},{status:400});
      const type = await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomTypeId).first<Record<string,unknown>>();
      if (!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const requestedRatePlan=(body.ratePlan||"BAR").trim().toUpperCase(),ratePlan=await db.prepare("SELECT code FROM rate_plans WHERE property_id=pms_current_property_id() AND code=? AND active").bind(requestedRatePlan).first();
      if(!ratePlan)return Response.json({error:"활성 요금제를 선택하세요."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const room = body.roomId ? await db.prepare("SELECT * FROM rooms WHERE id=? AND room_type_id=? AND property_id=pms_current_property_id() AND active").bind(body.roomId,body.roomTypeId).first<Record<string,unknown>>() : null;
      if (body.roomId && !room) return Response.json({error:"선택한 객실과 객실 타입이 일치하지 않습니다."},{status:409});
      const guestId=crypto.randomUUID(), reservationId=crypto.randomUUID(), confirmation=`SEL-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`;
      const statements = [
        db.prepare("INSERT INTO guests VALUES (?, pms_current_property_id(), ?, ?, ?, ?, 'NONE', ?, '[]', ?)").bind(guestId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.nationality||"KR",now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, pms_current_property_id(), ?, ?, ?, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, ?, '', 1, ?, ?)").bind(reservationId,confirmation,guestId,body.roomTypeId,body.roomId||null,body.arrivalDate,body.departureDate,Number(body.adults)||1,Number(body.children)||0,body.source||"Direct",requestedRatePlan,Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, pms_current_property_id(), ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for (const stayDate of datesBetween(body.arrivalDate,body.departureDate)) {
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(reservationId,body.roomTypeId,stayDate));
        if (body.roomId) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(reservationId,body.roomId,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_RESERVATION', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,reservationId,jsonb({confirmation,status:"DUE_IN"}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'reservation.created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),reservationId,jsonb({reservationId,confirmation}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "edit_reservation" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 수정할 수 있습니다."},{status:409});
      if(await db.prepare("SELECT id FROM rooming_list_entries WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId).first()) return Response.json({error:"그룹 픽업 예약은 블록 rooming list에서 수정하세요."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const type=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const requestedRatePlan=(body.ratePlan||String(reservation.rate_plan)).trim().toUpperCase(),ratePlan=await db.prepare("SELECT code FROM rate_plans WHERE property_id=pms_current_property_id() AND code=? AND active").bind(requestedRatePlan).first();if(!ratePlan)return Response.json({error:"활성 요금제를 선택하세요."},{status:400});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!stayDates.length) return Response.json({error:"올바른 숙박 일정을 입력하세요."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const retainedRoom=reservation.room_id && reservation.room_type_id===body.roomTypeId ? String(reservation.room_id) : null;
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, pms_current_property_id(), ?, ?, 'EDIT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_type_id=?, room_id=?, arrival_date=?, departure_date=?, adults=?, children=?, rate_plan=?, nightly_rate=?, eta=?, notes=?, version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN' AND version=?").bind(body.roomTypeId,retainedRoom,body.arrivalDate,body.departureDate,Math.max(1,Number(body.adults)||1),Math.max(0,Number(body.children)||0),requestedRatePlan,Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,body.notes||"",now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of stayDates){
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(body.reservationId,body.roomTypeId,stayDate));
        if(retainedRoom) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(body.reservationId,retainedRoom,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'EDIT_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb(reservation),jsonb({roomTypeId:body.roomTypeId,arrivalDate:body.arrivalDate,departureDate:body.departureDate,roomId:retainedRoom}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'reservation.updated', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,version:expectedVersion+1}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "assign_room" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약에만 객실을 배정할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.room_type_id!==reservation.room_type_id) return Response.json({error:"예약 객실 타입과 배정 객실 타입이 일치하지 않습니다."},{status:409});
      if(room.housekeeping_status==="OUT_OF_SERVICE") return Response.json({error:"판매 중지 객실은 배정할 수 없습니다."},{status:409});
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, pms_current_property_id(), ?, ?, 'ASSIGN_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of datesBetween(String(reservation.arrival_date),String(reservation.departure_date))) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'ASSIGN_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb({roomId:reservation.room_id}),jsonb({roomId:body.roomId}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'reservation.room_assigned', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,roomId:body.roomId}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "move_room" && reservation) {
      if(reservation.status!=="IN_HOUSE"||!reservation.room_id) return Response.json({error:"투숙 중이고 객실이 배정된 예약만 룸 무브할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"룸 무브 사유를 입력하세요."},{status:400});
      if(body.roomId===reservation.room_id) return Response.json({error:"현재 객실과 다른 객실을 선택하세요."},{status:400});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.front_desk_status!=="VACANT"||!["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"공실이며 청소 또는 점검이 완료된 객실만 이동할 수 있습니다."},{status:409});
      const futureDates=datesBetween(businessDate,String(reservation.departure_date)); if(!futureDates.length) return Response.json({error:"남은 숙박일이 없습니다."},{status:409});
      const moveId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, pms_current_property_id(), ?, ?, 'MOVE_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id() AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='IN_HOUSE' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=? AND property_id=pms_current_property_id()").bind(String(reservation.room_id)),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND property_id=pms_current_property_id() AND front_desk_status='VACANT'").bind(body.roomId),
        db.prepare("INSERT INTO room_moves VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?)").bind(moveId,body.reservationId,String(reservation.room_id),body.roomId,businessDate,body.reason.trim(),body.notes||"",actor,now),
      ];
      for(const stayDate of futureDates) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, pms_current_property_id(), ?, ?, 'PENDING', 1, NULL, '룸 무브 출발 객실', ?)").bind(crypto.randomUUID(),String(reservation.room_id),businessDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'MOVE_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb({roomId:reservation.room_id}),jsonb({roomId:body.roomId,reason:body.reason}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'stay.room_moved', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,fromRoomId:reservation.room_id,toRoomId:body.roomId,reason:body.reason}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "cancel_reservation" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약만 취소할 수 있습니다."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"예약 취소 사유를 입력하세요."},{status:400});
      const groupEntry=await db.prepare("SELECT * FROM rooming_list_entries WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId).first<Record<string,unknown>>();
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_transitions VALUES (?, pms_current_property_id(), ?, 'DUE_IN', 'CANCELLED', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CANCELLED', version=version+1, notes=notes || ?, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN'").bind(`\n[취소] ${body.reason.trim()}`,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CANCEL_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb(reservation),jsonb({status:"CANCELLED",reason:body.reason.trim()}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'reservation.cancelled', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,reason:body.reason.trim()}),now),
      ];
      if(groupEntry){statements.push(db.prepare("DELETE FROM block_pickup_nights WHERE rooming_entry_id=? AND property_id=pms_current_property_id()").bind(String(groupEntry.id)));statements.push(db.prepare("UPDATE rooming_list_entries SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(now,String(groupEntry.id)));}
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "update_inventory_control") {
      const stayDate=String(body.stayDate), roomType=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id=pms_current_property_id()").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!roomType) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const horizon=new Date(`${businessDate}T00:00:00Z`);horizon.setUTCDate(horizon.getUTCDate()+365); if(stayDate<businessDate||stayDate>horizon.toISOString().slice(0,10)) return Response.json({error:"영업일부터 365일 범위만 수정할 수 있습니다."},{status:400});
      const capacity=await db.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id=pms_current_property_id() AND room_type_id=? AND active AND housekeeping_status<>'OUT_OF_SERVICE'").bind(body.roomTypeId).first<{count:number}>(); const physical=Number(capacity?.count??0);
      const sellLimit=body.sellLimit===""?physical:Number(body.sellLimit), minStay=Number(body.minStay||1), price=body.priceOverride===""?null:Number(body.priceOverride), closed=body.closed==="true",websiteClosed=body.websiteClosed==="true";
      if(!Number.isInteger(sellLimit)||sellLimit<0||sellLimit>physical||!Number.isInteger(minStay)||minStay<1||minStay>30||price!==null&&(!Number.isFinite(price)||price<0)) return Response.json({error:"판매 수량·최소 숙박·요금을 올바르게 입력하세요."},{status:400});
      const reserved=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first<{count:number}>(); if(!closed&&sellLimit<Number(reserved?.count??0)) return Response.json({error:"이미 확정된 예약 수보다 판매 한도를 낮출 수 없습니다."},{status:409});
      const existing=await db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first(); const controlId=String((existing as Record<string,unknown>|null)?.id??crypto.randomUUID());
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO inventory_controls(id,property_id,room_type_id,stay_date,sell_limit,closed,min_stay,close_to_arrival,close_to_departure,price_override,website_closed,updated_at,updated_by) VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(property_id,room_type_id,stay_date) DO UPDATE SET sell_limit=excluded.sell_limit,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,price_override=excluded.price_override,website_closed=excluded.website_closed,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(controlId,body.roomTypeId,stayDate,sellLimit,closed,minStay,body.cta==="true",body.ctd==="true",price,websiteClosed,now,actor),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'UPDATE_INVENTORY_CONTROL', 'inventory_control', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,controlId,existing?jsonb(existing):null,jsonb({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),websiteClosed:Boolean(websiteClosed),minStay,cta:body.cta==="true",ctd:body.ctd==="true",price}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'inventory.updated', 'room_type', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.roomTypeId,jsonb({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,price}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "create_account_profile") {
      const type=String(body.type),name=body.name?.trim(); if(!["COMPANY","TRAVEL_AGENT","SOURCE","GROUP"].includes(type)||!name) return Response.json({error:"프로필 유형과 이름을 올바르게 입력하세요."},{status:400});
      const profileId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO account_profiles VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, true, 1, ?, ?)").bind(profileId,type,name,body.externalId?.trim()||null,body.email?.trim()||null,body.phone?.trim()||null,body.negotiatedRateCode?.trim()||null,body.creditStatus||"CASH",body.notes||"",now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_ACCOUNT_PROFILE', 'account_profile', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,profileId,jsonb({type,name,externalId:body.externalId||null}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'profile.created', 'account_profile', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),profileId,jsonb({profileId,type,name}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "create_business_block") {
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.name?.trim()||!stayDates.length) return Response.json({error:"블록 이름과 올바른 일정을 입력하세요."},{status:400});
      let allocations:Array<{roomTypeId:string;rooms:number;rate:number}>; try{allocations=JSON.parse(body.allocations||"[]") as Array<{roomTypeId:string;rooms:number;rate:number}>}catch{return Response.json({error:"객실 할당 정보가 올바르지 않습니다."},{status:400})}
      allocations=allocations.filter(item=>item.roomTypeId&&Number.isInteger(Number(item.rooms))&&Number(item.rooms)>0&&Number(item.rate)>=0).map(item=>({...item,rooms:Number(item.rooms),rate:Number(item.rate)})); if(!allocations.length) return Response.json({error:"한 개 이상의 객실 타입 할당을 입력하세요."},{status:400});
      const types=await db.prepare("SELECT id FROM room_types WHERE property_id=pms_current_property_id()").all<{id:string}>(); const validTypes=new Set(types.results.map(type=>type.id)); if(allocations.some(item=>!validTypes.has(item.roomTypeId))) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const accountId=body.accountProfileId||null,groupId=body.groupProfileId||null; if(accountId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id=pms_current_property_id() AND type IN ('COMPANY','TRAVEL_AGENT','SOURCE') AND active").bind(accountId).first()) return Response.json({error:"유효한 회사·여행사·소스 프로필을 선택하세요."},{status:400}); if(groupId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id=pms_current_property_id() AND type='GROUP' AND active").bind(groupId).first()) return Response.json({error:"유효한 그룹 프로필을 선택하세요."},{status:400});
      const blockId=crypto.randomUUID(),code=body.code?.trim()||`BLK-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,status=["TENTATIVE","DEFINITE"].includes(body.status)?body.status:"TENTATIVE",cutoffDate=body.cutoffDate||body.arrivalDate,deduct=body.deductInventory!=="false";
      const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO business_blocks VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 1, NULL, ?, ?)").bind(blockId,code,body.name.trim(),accountId,groupId,body.arrivalDate,body.departureDate,status,body.reservationMethod||"ROOMING_LIST",deduct,cutoffDate,body.notes||"",now,now)];
      for(const allocation of allocations) for(const stayDate of stayDates) statements.push(db.prepare("INSERT INTO block_inventory VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)").bind(crypto.randomUUID(),blockId,allocation.roomTypeId,stayDate,allocation.rooms,allocation.rooms,allocation.rate,cutoffDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_BUSINESS_BLOCK', 'business_block', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,blockId,jsonb({code,name:body.name,status,arrivalDate:body.arrivalDate,departureDate:body.departureDate,allocations}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'block.created', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),blockId,jsonb({blockId,code,status}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "update_block_inventory") {
      const row=await db.prepare("SELECT bi.*,bb.status block_status FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id WHERE bi.block_id=? AND bi.room_type_id=? AND bi.stay_date=? AND bi.property_id=pms_current_property_id()").bind(body.blockId,body.roomTypeId,body.stayDate).first<Record<string,unknown>>(); if(!row||!["TENTATIVE","DEFINITE"].includes(String(row.block_status))) return Response.json({error:"수정 가능한 블록 재고를 찾지 못했습니다."},{status:409});
      const rooms=Number(body.rooms),rate=Number(body.rate); if(!Number.isInteger(rooms)||rooms<Number(row.picked_up)||!Number.isFinite(rate)||rate<0) return Response.json({error:"픽업 수보다 낮지 않은 객실 수와 올바른 요금을 입력하세요."},{status:400});
      const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=?,rate=?,version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(rooms,rate,now,row.id,Number(row.version)),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'UPDATE_BLOCK_INVENTORY', 'block_inventory', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(row.id),jsonb(row),jsonb({currentRooms:rooms,rate}),now),db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'block.inventory_updated', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,jsonb({blockId:body.blockId,roomTypeId:body.roomTypeId,stayDate:body.stayDate,rooms,rate}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "add_rooming_entry") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND property_id=pms_current_property_id() AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block) return Response.json({error:"픽업 가능한 블록을 찾지 못했습니다."},{status:409});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.firstName?.trim()||!body.lastName?.trim()||!stayDates.length||body.arrivalDate<String(block.arrival_date)||body.departureDate>String(block.departure_date)) return Response.json({error:"고객명과 블록 범위 안의 일정을 입력하세요."},{status:400});
      const grid=await db.prepare("SELECT * FROM block_inventory WHERE block_id=? AND room_type_id=? AND property_id=pms_current_property_id() AND stay_date>=? AND stay_date<? ORDER BY stay_date").bind(body.blockId,body.roomTypeId,body.arrivalDate,body.departureDate).all<Record<string,unknown>>(); if(grid.results.length!==stayDates.length) return Response.json({error:"선택한 객실 타입의 블록 할당이 일정 전체에 없습니다."},{status:409});
      const entryId=crypto.randomUUID(),rate=Number(body.rate)||Number(grid.results[0]?.rate??0); const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO rooming_list_entries VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, 1, ?, ?)").bind(entryId,body.blockId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.arrivalDate,body.departureDate,body.roomTypeId,rate,body.notes||"",now,now),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'ADD_ROOMING_ENTRY', 'rooming_list_entry', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,entryId,jsonb({blockId:body.blockId,firstName:body.firstName,lastName:body.lastName,roomTypeId:body.roomTypeId}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "pickup_rooming_entry") {
      const entry=await db.prepare("SELECT rl.*,bb.code block_code,bb.status block_status FROM rooming_list_entries rl JOIN business_blocks bb ON bb.id=rl.block_id AND bb.property_id=rl.property_id WHERE rl.id=? AND rl.property_id=pms_current_property_id()").bind(body.entryId).first<Record<string,unknown>>(); if(!entry||entry.status!=="PENDING"||!["TENTATIVE","DEFINITE"].includes(String(entry.block_status))) return Response.json({error:"이미 픽업됐거나 픽업할 수 없는 rooming list 항목입니다."},{status:409});
      const ratePlan=await db.prepare("SELECT code FROM rate_plans WHERE property_id=pms_current_property_id() AND active ORDER BY CASE WHEN code='CORP' THEN 0 WHEN code='BAR' THEN 1 ELSE 2 END,code LIMIT 1").first<{code:string}>();if(!ratePlan)return Response.json({error:"그룹 예약에 사용할 활성 요금제가 없습니다."},{status:409});
      const reservationId=crypto.randomUUID(),guestId=crypto.randomUUID(),confirmation=`SEL-${String(entry.arrival_date).replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,stayDates=datesBetween(String(entry.arrival_date),String(entry.departure_date)); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO guests VALUES (?, pms_current_property_id(), ?, ?, ?, ?, 'NONE', 'KR', '[]', ?)").bind(guestId,String(entry.first_name),String(entry.last_name),entry.email??null,entry.phone??null,now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, pms_current_property_id(), ?, ?, NULL, ?, ?, 'DUE_IN', 1, 0, 'Group', ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,String(entry.room_type_id),String(entry.arrival_date),String(entry.departure_date),ratePlan.code,Number(entry.rate),`Block ${entry.block_code} · Rooming list`,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, pms_current_property_id(), ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for(const stayDate of stayDates){statements.push(db.prepare("INSERT INTO block_pickup_nights(property_id,block_id,rooming_entry_id,room_type_id,stay_date,created_at) VALUES (pms_current_property_id(),?,?,?,?,?)").bind(String(entry.block_id),String(entry.id),String(entry.room_type_id),stayDate,now));statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES (pms_current_property_id(),?,?,?)").bind(reservationId,String(entry.room_type_id),stayDate));}
      statements.push(db.prepare("UPDATE rooming_list_entries SET status='PICKED_UP',reservation_id=?,version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='PENDING'").bind(reservationId,now,String(entry.id))); statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'PICKUP_ROOMING_ENTRY', 'rooming_list_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(entry.id),jsonb(entry),jsonb({status:"PICKED_UP",reservationId,confirmation}),now)); statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'block.reservation_picked_up', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),String(entry.block_id),jsonb({blockId:entry.block_id,entryId:entry.id,reservationId,confirmation}),now)); if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "cutoff_block") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND property_id=pms_current_property_id() AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block)return Response.json({error:"마감 가능한 블록을 찾지 못했습니다."},{status:409}); const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=? AND property_id=pms_current_property_id()").bind(now,body.blockId),db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status IN ('TENTATIVE','DEFINITE')").bind(now,now,body.blockId),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CUTOFF_BLOCK', 'business_block', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.blockId,jsonb(block),jsonb({status:"CUTOFF"}),now),db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,jsonb({blockId:body.blockId}),now)];if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));await db.batch(statements);
    } else if (body.action === "create_channel_connection") {
      const provider=body.provider?.trim().toUpperCase(),externalPropertyId=body.externalPropertyId?.trim();if(!provider||!externalPropertyId)return Response.json({error:"채널과 외부 호텔 ID를 입력하세요."},{status:400});const connectionId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_connections VALUES (?, pms_current_property_id(), ?, ?, ?, 'SANDBOX', 'ACTIVE', NULL, ?, ?, ?)").bind(connectionId,provider,externalPropertyId,body.name?.trim()||`${provider} Sandbox`,now,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_CHANNEL_CONNECTION', 'channel_connection', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,connectionId,jsonb({provider,externalPropertyId,environment:"SANDBOX"}),now)]);
    } else if (body.action === "create_channel_mapping") {
      const connection=await db.prepare("SELECT id FROM channel_connections WHERE id=? AND property_id=pms_current_property_id() AND status='ACTIVE'").bind(body.connectionId).first(),roomType=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id=pms_current_property_id()").bind(body.roomTypeId).first(),requestedRatePlan=(body.ratePlan||"OTA").trim().toUpperCase(),ratePlan=await db.prepare("SELECT code FROM rate_plans WHERE property_id=pms_current_property_id() AND code=? AND active").bind(requestedRatePlan).first();if(!connection||!roomType||!ratePlan||!body.externalRoomTypeId?.trim()||!body.externalRatePlanId?.trim())return Response.json({error:"활성 연결, 객실 타입, 내부 요금제, 외부 room/rate ID를 입력하세요."},{status:400});const mappingId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_mappings VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, true, ?, ?)").bind(mappingId,body.connectionId,body.roomTypeId,body.externalRoomTypeId.trim(),requestedRatePlan,body.externalRatePlanId.trim(),now,now),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_CHANNEL_MAPPING', 'channel_mapping', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,mappingId,jsonb({connectionId:body.connectionId,roomTypeId:body.roomTypeId,ratePlan:requestedRatePlan,externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId}),now)]);
    } else if (body.action === "queue_ari_delta") {
      const mapping=await db.prepare("SELECT m.*,c.provider FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id WHERE m.id=? AND m.property_id=pms_current_property_id() AND c.property_id=pms_current_property_id() AND m.active AND c.status='ACTIVE'").bind(body.mappingId).first<Record<string,unknown>>(),dates=datesBetween(body.startDate,(()=>{const end=new Date(`${body.endDate}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);return end.toISOString().slice(0,10)})());
      if(!mapping||!dates.length)return Response.json({error:"활성 매핑과 올바른 ARI 일자 범위를 선택하세요."},{status:400});
      const [physicalResult,controlsResult,bookedResult,heldResult,revisionsResult]=await db.batch([
        db.prepare("SELECT COUNT(*) count,MAX(rt.base_rate) base_rate FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.property_id=pms_current_property_id() AND r.room_type_id=? AND r.active AND r.housekeeping_status<>'OUT_OF_SERVICE'").bind(mapping.room_type_id),
        db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND room_type_id=? AND stay_date>=? AND stay_date<=?").bind(mapping.room_type_id,body.startDate,body.endDate),
        db.prepare("SELECT stay_date,COUNT(*) count FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND room_type_id=? AND stay_date>=? AND stay_date<=? GROUP BY stay_date").bind(mapping.room_type_id,body.startDate,body.endDate),
        db.prepare("SELECT bi.stay_date,COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id WHERE bi.property_id=pms_current_property_id() AND bi.room_type_id=? AND bi.stay_date>=? AND bi.stay_date<=? AND bb.deduct_inventory AND bb.status IN ('TENTATIVE','DEFINITE') GROUP BY bi.stay_date").bind(mapping.room_type_id,body.startDate,body.endDate),
        db.prepare("SELECT stay_date,COALESCE(MAX(revision),0)+1 revision FROM ari_updates WHERE mapping_id=? AND property_id=pms_current_property_id() AND stay_date>=? AND stay_date<=? GROUP BY stay_date").bind(mapping.id,body.startDate,body.endDate),
      ]);
      const physical=physicalResult.results[0] as {count?:number;base_rate?:number}|undefined,byDate=(rows:Array<Record<string,unknown>>)=>new Map(rows.map(row=>[String(row.stay_date),row])),controls=byDate(controlsResult.results),booked=byDate(bookedResult.results),held=byDate(heldResult.results),revisions=byDate(revisionsResult.results);
      const {ariRows,ariValues,outboxRows,outboxValues}=buildAriDeltaInserts({dates,mapping:{id:mapping.id,connection_id:mapping.connection_id},physical,controls,booked,held,revisions,now});
      await db.batch([
        db.prepare(`INSERT INTO ari_updates(id,property_id,connection_id,mapping_id,stay_date,revision,available,closed,min_stay,close_to_arrival,close_to_departure,rate,currency,payload_json,status,attempts,created_at,sent_at,last_error) VALUES ${ariRows}`).bind(...ariValues),
        db.prepare(`INSERT INTO outbox_events(id,property_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,published_at) VALUES ${outboxRows}`).bind(...outboxValues),
      ]);
    } else if (body.action === "dispatch_ari_update") {
      const update=await db.prepare("SELECT a.*,c.provider FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id WHERE a.id=? AND a.property_id=pms_current_property_id() AND c.property_id=pms_current_property_id() AND a.status IN ('PENDING','FAILED')").bind(body.updateId).first<Record<string,unknown>>();if(!update)return Response.json({error:"전송 또는 재처리 가능한 ARI 업데이트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(update.attempts)+1;await db.batch([db.prepare("UPDATE ari_updates SET status=?,attempts=?,sent_at=?,last_error=? WHERE id=? AND property_id=pms_current_property_id()").bind(failed?"FAILED":"SENT",attempt,failed?null:now,failed?"SANDBOX_TIMEOUT":null,update.id),db.prepare("UPDATE channel_connections SET last_sync_at=CASE WHEN ?=1 THEN last_sync_at ELSE ? END,updated_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(failed?1:0,now,now,update.connection_id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, pms_current_property_id(), 'OUTBOUND', ?, 'ari_update', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),update.provider,update.id,attempt,failed?"FAILED":"ACKED",failed?504:200,failed?"TIMEOUT":null,failed?"Sandbox timeout":null,update.payload_json,now,actor)]);
    } else if (body.action === "ingest_channel_message") {
      const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND property_id=pms_current_property_id() AND status='ACTIVE'").bind(body.connectionId).first<Record<string,unknown>>();if(!connection)return Response.json({error:"활성 채널 연결을 선택하세요."},{status:400});const duplicate=await db.prepare("SELECT id FROM inbound_channel_messages WHERE connection_id=? AND message_id=? AND property_id=pms_current_property_id()").bind(body.connectionId,body.messageId).first();if(duplicate)return Response.json(pmsMutationReceipt({action:body.action,domain:registration.domain,idempotencyKey,body,replayed:true}),{headers:{"X-Channel-Duplicate":"true"}});
      const payload:ChannelPayload={connectionId:body.connectionId,messageId:body.messageId,eventType:body.eventType,externalReservationId:body.externalReservationId,revision:Number(body.revision),externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId,firstName:body.firstName,lastName:body.lastName,email:body.email,arrivalDate:body.arrivalDate,departureDate:body.departureDate,adults:Number(body.adults),children:Number(body.children),nightlyRate:Number(body.nightlyRate),currency:body.currency||"KRW"},messageId=crypto.randomUUID();await db.prepare("INSERT INTO inbound_channel_messages VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, NULL, ?, NULL)").bind(messageId,body.connectionId,connection.provider,body.messageId,body.eventType.toUpperCase(),body.externalReservationId,Number(body.revision),jsonb(payload),now).run();const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=? AND property_id=pms_current_property_id()").bind(messageId).first<Record<string,unknown>>();
      try{await processChannelMessage(db,message!,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error);await db.batch([db.prepare("UPDATE inbound_channel_messages SET status='FAILED',attempts=attempts+1,last_error=? WHERE id=? AND property_id=pms_current_property_id()").bind(detail,messageId),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, pms_current_property_id(), 'INBOUND', ?, 'channel_message', ?, 1, 'FAILED', 409, 'PROCESSING_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,messageId,detail,jsonb(payload),now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId,status:"FAILED"},{status:409});}
    } else if (body.action === "replay_channel_message") {
      const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=? AND property_id=pms_current_property_id() AND status='FAILED'").bind(body.messageId).first<Record<string,unknown>>();if(!message)return Response.json({error:"DLQ에서 재처리할 메시지를 찾지 못했습니다."},{status:409});const payload=(typeof message.payload_json==="string"?JSON.parse(message.payload_json):message.payload_json) as ChannelPayload;try{await processChannelMessage(db,message,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error),attempt=Number(message.attempts)+1;await db.batch([db.prepare("UPDATE inbound_channel_messages SET attempts=?,last_error=? WHERE id=? AND property_id=pms_current_property_id()").bind(attempt,detail,message.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, pms_current_property_id(), 'INBOUND', ?, 'channel_message', ?, ?, 'FAILED', 409, 'REPLAY_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),message.provider,message.id,attempt,detail,message.payload_json,now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId:message.id,status:"FAILED"},{status:409});}
    } else if (body.action === "dispatch_outbox_event") {
      const event=await db.prepare("SELECT * FROM outbox_events WHERE id=? AND property_id=pms_current_property_id() AND status IN ('PENDING','FAILED')").bind(body.eventId).first<Record<string,unknown>>();if(!event)return Response.json({error:"전송 또는 재처리 가능한 outbox 이벤트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(event.attempts)+1,provider=body.provider||"WEBHOOK";await db.batch([db.prepare("UPDATE outbox_events SET status=?,attempts=?,published_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(failed?"FAILED":"PUBLISHED",attempt,failed?null:now,event.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, pms_current_property_id(), 'OUTBOUND', ?, 'outbox_event', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),provider,event.id,attempt,failed?"FAILED":"ACKED",failed?503:200,failed?"UNAVAILABLE":null,failed?"Sandbox endpoint unavailable":null,event.payload_json,now,actor)]);
    } else if (body.action === "open_cashier") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>();
      const openingAmount = Number(body.openingAmount || 0); if (!Number.isFinite(openingAmount) || openingAmount < 0) return Response.json({error:"시재금은 0원 이상이어야 합니다."},{status:400});
      const existing = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN'").bind(actor).first();
      if (existing) return Response.json({error:"이미 개시된 캐셔 세션이 있습니다."},{status:409});
      const cashierId = crypto.randomUUID(); const statements = [
        db.prepare("INSERT INTO cashier_sessions VALUES (?, pms_current_property_id(), ?, ?, 'OPEN', ?, NULL, NULL, NULL, ?, NULL)").bind(cashierId,actor,property?.business_date,openingAmount,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'OPEN_CASHIER', 'cashier_session', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,cashierId,jsonb({openingAmount,businessDate:property?.business_date}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "close_cashier") {
      const session = await db.prepare("SELECT * FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first<Record<string,unknown>>();
      if (!session) return Response.json({error:"개시된 캐셔 세션이 없습니다."},{status:409});
      const cash = await db.prepare("SELECT (SELECT COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind IN ('PAYMENT_REVERSAL','REFUND') THEN -amount ELSE 0 END),0) FROM folio_entries WHERE property_id=pms_current_property_id() AND business_date=? AND created_by=? AND payment_method='CASH')+(SELECT COALESCE(SUM(credit),0) FROM ar_ledger_entries WHERE property_id=pms_current_property_id() AND business_date=? AND created_by=? AND kind='PAYMENT' AND payment_method='CASH') total").bind(session.business_date,actor,session.business_date,actor).first<{total:number}>();
      const expected = Number(session.opening_amount)+Number(cash?.total??0), counted=Number(body.countedAmount);
      if (!Number.isFinite(counted) || counted < 0) return Response.json({error:"실사 현금을 올바르게 입력하세요."},{status:400});
      const variance = counted-expected; const statements = [
        db.prepare("UPDATE cashier_sessions SET status='CLOSED', expected_amount=?, counted_amount=?, variance=?, closed_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(expected,counted,variance,now,session.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CLOSE_CASHIER', 'cashier_session', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,session.id,jsonb(session),jsonb({status:"CLOSED",expected,counted,variance}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "run_night_audit") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>(); const businessDate=String(property?.business_date);
      const controls = await operationalControls(db,businessDate,actor);
      if (!controls.canClose) return Response.json({error:"영업일 마감 선행조건이 충족되지 않았습니다.",blockers:controls.blockers},{status:409});
      const stays = await db.prepare("SELECT r.id, r.room_id, COALESCE((SELECT rr.sell_rate FROM reservation_rate_nights rr WHERE rr.reservation_id=r.id AND rr.stay_date=?),r.nightly_rate) nightly_rate FROM reservations r WHERE r.property_id=pms_current_property_id() AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate,businessDate).all<{id:string;room_id:string;nightly_rate:number}>();
      const cutoffBlocks=await db.prepare("SELECT id FROM business_blocks WHERE property_id=pms_current_property_id() AND status IN ('TENTATIVE','DEFINITE') AND cutoff_date IS NOT NULL AND cutoff_date<=?").bind(businessDate).all<{id:string}>();
      const next = new Date(`${businessDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1); const nextDate=next.toISOString().slice(0,10); const auditId=crypto.randomUUID();
      const statements = [db.prepare("INSERT INTO night_audits VALUES (?, pms_current_property_id(), ?, 'COMPLETED', '[]', ?, ?, ?, ?)").bind(auditId,businessDate,jsonb({roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length,nextBusinessDate:nextDate}),now,now,actor)];
      for (const stay of stays.results) {
        const entryId=crypto.randomUUID(),parts=inclusiveComponents(Number(stay.nightly_rate),0.10,0);
        statements.push(db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'CHARGE', 'ROOM', '객실료 자동 전기', ?, NULL, ?, ?, 'night-audit', NULL)").bind(entryId,stay.id,parts.total,businessDate,now));
        statements.push(db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,stay.id,`fw-${stay.id}`,parts.net,parts.tax,parts.service,now));
        if (stay.room_id) statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, pms_current_property_id(), ?, ?, 'PENDING', 2, NULL, '스테이오버 객실', ?)").bind(crypto.randomUUID(),stay.room_id,nextDate,now));
      }
      for(const block of cutoffBlocks.results){statements.push(db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=? AND property_id=pms_current_property_id()").bind(now,block.id));statements.push(db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND property_id=pms_current_property_id()").bind(now,now,block.id));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),block.id,jsonb({blockId:block.id,automatic:true,businessDate}),now));}
      statements.push(db.prepare("UPDATE properties SET business_date=? WHERE id=pms_current_property_id() AND business_date=?").bind(nextDate,businessDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CLOSE_BUSINESS_DATE', 'night_audit', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,auditId,jsonb({businessDate}),jsonb({nextDate,roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'business_date.closed', 'night_audit', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),auditId,jsonb({businessDate,nextDate}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "mark_no_show" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 노쇼 처리할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 노쇼 처리할 수 없습니다."},{status:409});
      const statements = [
        db.prepare("INSERT INTO reservation_transitions VALUES (?, pms_current_property_id(), ?, 'DUE_IN', 'NO_SHOW', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='NO_SHOW', version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN'").bind(now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'MARK_NO_SHOW', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb(reservation),jsonb({status:"NO_SHOW"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'reservation.no_show', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 체크인할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 체크인할 수 없습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"객실 배정이 필요합니다."},{status:409});
      const room = await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id=pms_current_property_id()").bind(reservation.room_id).first<Record<string, unknown>>();
      if (!room || !["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"청소 완료 또는 점검 완료 객실만 체크인할 수 있습니다."},{status:409});
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, pms_current_property_id(), ?, 'DUE_IN', 'IN_HOUSE', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='IN_HOUSE', version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='DUE_IN'").bind(now, body.reservationId),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND property_id=pms_current_property_id()").bind(reservation.room_id),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,"CHECK_IN","reservation",body.reservationId,jsonb(reservation),jsonb({status:"IN_HOUSE"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'stay.checked_in', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "check_out" && reservation) {
      if (reservation.status !== "IN_HOUSE") return Response.json({error:"투숙 중 예약만 체크아웃할 수 있습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"예약에 배정된 객실이 없습니다."},{status:409});
      const bal = await db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) balance FROM folio_entries WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId).first<{balance:number}>();
      if (Math.abs(bal?.balance ?? 0) > .01) return Response.json({error:"잔액을 정산한 뒤 체크아웃하세요."},{status:409});
      const task = crypto.randomUUID();
      // A same-day early checkout still represents a minimum one-night stay.
      // Keeping the effective departure after arrival preserves the database
      // stay-range invariant and the historical occupancy night.
      const minimumDeparture=addIsoDays(String(reservation.arrival_date),1);
      const actualDeparture=businessDate<minimumDeparture?minimumDeparture:businessDate;
      const effectiveDeparture=String(reservation.departure_date)>actualDeparture?actualDeparture:String(reservation.departure_date);
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, pms_current_property_id(), ?, 'IN_HOUSE', 'CHECKED_OUT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CHECKED_OUT', departure_date=?, version=version+1, updated_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='IN_HOUSE'").bind(effectiveDeparture,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id=pms_current_property_id() AND stay_date>=?").bind(body.reservationId,effectiveDeparture),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id=pms_current_property_id() AND stay_date>=?").bind(body.reservationId,effectiveDeparture),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=? AND property_id=pms_current_property_id()").bind(reservation.room_id),
        db.prepare("INSERT INTO housekeeping_tasks VALUES (?, pms_current_property_id(), ?, ?, 'PENDING', 1, NULL, '체크아웃 객실', ?)").bind(task,reservation.room_id,businessDate,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,"CHECK_OUT","reservation",body.reservationId,jsonb(reservation),jsonb({status:"CHECKED_OUT",departureDate:effectiveDeparture}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'stay.checked_out', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_payment" && reservation) {
      const amount = Number(body.amount); if (!(amount > 0)) return Response.json({error:"결제 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"결제 전 캐셔 세션을 개시하세요."},{status:409});
      const windowId=await folioWindowFor(db,body.reservationId,"PAYMENT",body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'PAYMENT', 'PAYMENT', '프런트 결제', ?, ?, ?, ?, ?, NULL)").bind(entryId,body.reservationId,amount,body.method || "CARD",businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, 0, 0, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,amount,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'folio.payment_posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,amount,method:body.method||"CARD"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_charge" && reservation) {
      const amount=Number(body.amount); if(!(amount>0)) return Response.json({error:"전기 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"비용 전기 전 캐셔 세션을 개시하세요."},{status:409});
      const code=(body.code||"MISC").toUpperCase(),transactionCode=await db.prepare("SELECT * FROM transaction_codes WHERE property_id=pms_current_property_id() AND code=? AND active").bind(code).first<Record<string,unknown>>();
      if(!transactionCode)return Response.json({error:"활성 거래 코드를 선택하세요."},{status:400});
      const parts=inclusiveComponents(amount,Number(transactionCode.tax_rate),Number(transactionCode.service_rate)),windowId=await folioWindowFor(db,body.reservationId,code,body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(entryId,body.reservationId,code,body.description||String(transactionCode.name),parts.total,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,parts.net,parts.tax,parts.service,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'folio.posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,jsonb({reservationId:body.reservationId,amount,kind:"CHARGE"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "create_folio_window" && reservation) {
      const next=await db.prepare("SELECT COALESCE(MAX(window_no),0)+1 next_no FROM folio_windows WHERE reservation_id=? AND property_id=pms_current_property_id()").bind(body.reservationId).first<{next_no:number}>(),windowId=crypto.randomUUID(),payeeType=body.payeeType||"GUEST";
      if(!["GUEST","COMPANY","TRAVEL_AGENT","GROUP"].includes(payeeType))return Response.json({error:"올바른 지불 주체 유형을 선택하세요."},{status:400});
      if(body.accountProfileId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND property_id=pms_current_property_id() AND active").bind(body.accountProfileId).first())return Response.json({error:"유효한 계정 프로필을 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_windows VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL)").bind(windowId,body.reservationId,Number(next?.next_no??1),body.name?.trim()||`Window ${next?.next_no??1}`,payeeType,body.accountProfileId||null,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'CREATE_FOLIO_WINDOW', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb({windowId,payeeType}),now),mutationReceipt()]);
    } else if (body.action === "create_routing_rule" && reservation) {
      const code=(body.code||"").toUpperCase(),target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(body.windowId,body.reservationId).first(); if(!code||!target)return Response.json({error:"거래 코드와 열린 대상 폴리오를 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_routing_rules VALUES (?, pms_current_property_id(), ?, ?, ?, true, ?, ?) ON CONFLICT(reservation_id,transaction_code) DO UPDATE SET target_window_id=excluded.target_window_id,active=true").bind(crypto.randomUUID(),body.reservationId,code,body.windowId,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'UPSERT_FOLIO_ROUTING', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,jsonb({code,windowId:body.windowId}),now),mutationReceipt()]);
    } else if (body.action === "split_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id=pms_current_property_id() AND x.kind='CHARGE_REVERSAL'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id=pms_current_property_id() AND d.property_id=pms_current_property_id() AND f.kind='CHARGE'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount));
      if(!source||!(amount>0)||amount>Number(source.remaining)+0.001)return Response.json({error:"분할 가능한 원전표 잔액 안에서 금액을 입력하세요."},{status:409});
      const target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(body.targetWindowId,source.reservation_id).first(); if(!target||body.targetWindowId===source.folio_window_id)return Response.json({error:"다른 열린 폴리오 창을 선택하세요."},{status:400});
      const ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),reverseId=crypto.randomUUID(),repostId=crypto.randomUUID(),reason=body.reason?.trim()||"FOLIO_SPLIT";
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'CHARGE_REVERSAL', ?, ?, ?, NULL, ?, ?, ?, ?)").bind(reverseId,source.reservation_id,source.code,`분할 반대전표 · ${source.description}`,amount,businessDate,now,actor,source.id),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(reverseId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(repostId,source.reservation_id,source.code,`분할 전기 · ${source.description}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(repostId,source.reservation_id,body.targetWindowId,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'SPLIT_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),jsonb(source),jsonb({amount,targetWindowId:body.targetWindowId,reverseId,repostId,reason}),now),
        mutationReceipt(),
      ]);
    } else if (body.action === "reverse_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id=pms_current_property_id() AND x.kind=CASE f.kind WHEN 'CHARGE' THEN 'CHARGE_REVERSAL' ELSE 'PAYMENT_REVERSAL' END),0)-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id=pms_current_property_id() AND x.kind='REFUND'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id=pms_current_property_id() AND d.property_id=pms_current_property_id() AND f.kind IN ('CHARGE','PAYMENT')").bind(body.entryId).first<Record<string,unknown>>();
      if(!source||Number(source.remaining)<=0.001)return Response.json({error:"이미 전액 반대전표 처리된 전표입니다."},{status:409}); const reason=body.reason?.trim();if(!reason)return Response.json({error:"정정 사유를 입력하세요."},{status:400});
      const amount=roundMoney(Number(source.remaining)),ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),entryId=crypto.randomUUID(),kind=source.kind==='CHARGE'?'CHARGE_REVERSAL':'PAYMENT_REVERSAL';
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,kind,source.code,`반대전표 · ${source.description}`,amount,source.payment_method??null,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'REVERSE_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),jsonb(source),jsonb({entryId,kind,amount,reason}),now),mutationReceipt()]);
    } else if (body.action === "refund_payment") {
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"환불 전 캐셔 세션을 개시하세요."},{status:409});
      const source=await db.prepare("SELECT f.*,d.folio_window_id,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.property_id=pms_current_property_id() AND x.kind IN ('PAYMENT_REVERSAL','REFUND')),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.property_id=pms_current_property_id() AND d.property_id=pms_current_property_id() AND f.kind='PAYMENT'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),reason=body.reason?.trim();
      if(!source||source.payment_method==='DIRECT_BILL'||!(amount>0)||amount>Number(source.remaining)+0.001||!reason)return Response.json({error:"환불 가능 결제와 잔액, 사유를 확인하세요."},{status:409}); const entryId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'REFUND', 'REFUND', ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,`환불 · ${reason}`,amount,source.payment_method,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, 0, 0, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,amount,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'REFUND_PAYMENT', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),jsonb(source),jsonb({entryId,amount,reason}),now),mutationReceipt()]);
    } else if (body.action === "transfer_to_ar") {
      const window=await db.prepare(`SELECT w.*,r.id reservation_id,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id AND r.property_id=w.property_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id AND d.property_id=w.property_id LEFT JOIN folio_entries f ON f.id=d.entry_id AND f.property_id=w.property_id WHERE w.id=? AND w.property_id=pms_current_property_id() AND w.status='OPEN' GROUP BY w.id,r.id`).bind(body.windowId).first<Record<string,unknown>>(),profile=await db.prepare("SELECT * FROM account_profiles WHERE id=? AND property_id=pms_current_property_id() AND active AND credit_status='DIRECT_BILL'").bind(body.accountProfileId).first<Record<string,unknown>>();
      if(!window||Number(window.balance)<=0.001||!profile)return Response.json({error:"잔액이 있는 열린 폴리오와 후불 승인 계정을 선택하세요."},{status:409}); const dueDate=body.dueDate;if(!dueDate||dueDate<businessDate)return Response.json({error:"청구서 만기일을 확인하세요."},{status:400});
      const arAccountId=`ar-${profile.id}`,existingAccount=await db.prepare("SELECT credit_limit FROM ar_accounts WHERE id=? AND property_id=pms_current_property_id()").bind(arAccountId).first<{credit_limit:number}>(),accountBalance=await db.prepare("SELECT COALESCE(SUM(debit-credit),0) balance FROM ar_ledger_entries WHERE ar_account_id=? AND property_id=pms_current_property_id()").bind(arAccountId).first<{balance:number}>(),creditLimit=existingAccount?Number(existingAccount.credit_limit):Number(body.creditLimit||0),amount=roundMoney(Number(window.balance));if(creditLimit>0&&Number(accountBalance?.balance??0)+amount>creditLimit)return Response.json({error:"AR 신용 한도를 초과합니다."},{status:409});
      const base=Number(window.net_total)+Number(window.tax_total)+Number(window.service_total),ratio=base>0?amount/base:1,subtotal=roundMoney(Number(window.net_total)*ratio),tax=roundMoney(Number(window.tax_total)*ratio),service=roundMoney(amount-subtotal-tax),invoiceId=crypto.randomUUID(),paymentId=crypto.randomUUID(),invoiceNo=`AR-${businessDate.replaceAll('-','')}-${Math.floor(1000+Math.random()*9000)}`;
      await db.batch([
        db.prepare("INSERT INTO ar_accounts VALUES (?, pms_current_property_id(), ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT DO NOTHING").bind(arAccountId,profile.id,String(profile.external_id||profile.id),String(profile.name),creditLimit,now,now),
        db.prepare("INSERT INTO ar_invoices VALUES (?, pms_current_property_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)").bind(invoiceId,arAccountId,window.reservation_id,window.id,invoiceNo,businessDate,dueDate,subtotal,tax,service,amount,now,actor),
        db.prepare("INSERT INTO ar_ledger_entries VALUES (?, pms_current_property_id(), ?, ?, 'INVOICE', ?, 0, ?, NULL, ?, ?, ?, NULL)").bind(crypto.randomUUID(),arAccountId,invoiceId,amount,businessDate,`Folio transfer ${invoiceNo}`,now,actor),
        db.prepare("INSERT INTO folio_entries VALUES (?, pms_current_property_id(), ?, 'PAYMENT', 'DIRECT_BILL', ?, ?, 'DIRECT_BILL', ?, ?, ?, NULL)").bind(paymentId,window.reservation_id,`AR 이관 · ${invoiceNo}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, pms_current_property_id(), ?, ?, ?, 0, 0, 'KRW', NULL, ?, ?)").bind(paymentId,window.reservation_id,window.id,amount,`AR:${invoiceNo}`,now),
        db.prepare("UPDATE folio_windows SET status='TRANSFERRED',payee_type='COMPANY',payee_account_profile_id=?,closed_at=? WHERE id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(profile.id,now,window.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'TRANSFER_FOLIO_TO_AR', 'ar_invoice', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,invoiceId,jsonb({invoiceNo,amount,windowId:window.id,accountProfileId:profile.id}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, pms_current_property_id(), 'ar.invoice_issued', 'ar_invoice', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),invoiceId,jsonb({invoiceId,invoiceNo,amount}),now),
        mutationReceipt(),
      ]);
    } else if (body.action === "post_ar_payment") {
      const invoice=await db.prepare("SELECT i.*,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id AND l.property_id=i.property_id WHERE i.id=? AND i.property_id=pms_current_property_id() GROUP BY i.id").bind(body.invoiceId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),method=body.method||"BANK_TRANSFER";if(!invoice||!(amount>0)||amount>Number(invoice.balance)+0.001)return Response.json({error:"AR 청구서 잔액 안에서 수납 금액을 입력하세요."},{status:409});
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"AR 수납 전 캐셔 세션을 개시하세요."},{status:409}); const paid=amount>=Number(invoice.balance)-0.001;
      await db.batch([db.prepare("INSERT INTO ar_ledger_entries VALUES (?, pms_current_property_id(), ?, ?, 'PAYMENT', 0, ?, ?, ?, ?, ?, ?, NULL)").bind(crypto.randomUUID(),invoice.ar_account_id,invoice.id,amount,businessDate,method,`AR receipt ${invoice.invoice_no}`,now,actor),...(paid?[db.prepare("UPDATE ar_invoices SET status='PAID' WHERE id=? AND property_id=pms_current_property_id() AND status='OPEN'").bind(invoice.id)]:[]),db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, 'POST_AR_PAYMENT', 'ar_invoice', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(invoice.id),jsonb({balance:invoice.balance}),jsonb({amount,method,status:paid?'PAID':'OPEN'}),now),mutationReceipt()]);
    } else if (body.action === "housekeeping") {
      const status = body.status === "INSPECTED" ? "INSPECTED" : "CLEAN";
      const room = await db.prepare("SELECT id FROM rooms WHERE id=? AND property_id=pms_current_property_id()").bind(body.roomId).first();
      if (!room) return Response.json({error:"객실을 찾지 못했습니다."},{status:404});
      await db.batch([
        db.prepare("UPDATE rooms SET housekeeping_status=?, version=version+1 WHERE id=? AND property_id=pms_current_property_id()").bind(status,body.roomId),
        db.prepare("UPDATE housekeeping_tasks SET status='DONE', updated_at=? WHERE room_id=? AND business_date=? AND property_id=pms_current_property_id()").bind(now,body.roomId,businessDate),
        db.prepare("INSERT INTO audit_logs VALUES (?, pms_current_property_id(), ?, ?, ?, ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,"HOUSEKEEPING_COMPLETE","room",body.roomId,jsonb({housekeepingStatus:status}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else return Response.json({error:"지원하지 않는 작업입니다."},{status:400});
    invalidateSnapshots();
    return Response.json(pmsMutationReceipt({action:body.action,domain:registration.domain,idempotencyKey,body}));
  } catch (error) {
    const message=error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    if(error instanceof StaffAccessError||error instanceof StaffAuthError)return Response.json({error:error.message},{status:error.status});
    if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});
    if (/idempotency_keys_pkey|idempotency_keys\.key/iu.test(message)) return Response.json(pmsMutationReceipt({action:body.action,domain:registration.domain,idempotencyKey,body,replayed:true}), {headers:{"X-Idempotent-Replay":"true"}});
    const mapped=mapPmsError(message);
    if(mapped)return Response.json({error:mapped.error},{status:mapped.status});
    const errorId=crypto.randomUUID();
    console.error("[TALOS_PMS_ERROR]",{errorId,action:body.action,actor,propertyId:principal.propertyId,error:error instanceof Error?error.name:"UnknownError",message});
    return Response.json({error:"처리 중 오류가 발생했습니다. 문제가 계속되면 오류 ID를 관리자에게 알려 주세요.",errorId},{status:500});
  }
}
