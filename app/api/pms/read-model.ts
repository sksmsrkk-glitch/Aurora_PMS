/** Property-partitioned PMS read models and short-lived representation caches. */
import type { PmsDatabase } from "../../../db/pms-database";
import type { Principal } from "./auth";
import { runReport } from "./reporting";

type D1=PmsDatabase;

// A single database projection keeps all dashboard comparisons on the hotel's
// business date. In particular, it avoids mixing the browser's wall clock with
// night-audit time and gives the current and prior day the same revenue rules.
const DASHBOARD_COMPARISON_SQL = `
WITH context AS (
  SELECT business_date::date AS current_day, business_date::date - 1 AS prior_day
  FROM properties
  WHERE id=pms_current_property_id()
), days(period, stay_date) AS (
  SELECT 'current', current_day FROM context
  UNION ALL
  SELECT 'prior', prior_day FROM context
), daily AS (
  SELECT d.period,
    (SELECT COUNT(*) FROM reservations r
      WHERE r.property_id=pms_current_property_id()
        AND r.arrival_date=d.stay_date
        AND r.status NOT IN ('CANCELLED','NO_SHOW')) AS arrivals,
    (SELECT COUNT(*) FROM reservations r
      WHERE r.property_id=pms_current_property_id()
        AND r.arrival_date<=d.stay_date AND r.departure_date>d.stay_date
        AND r.status NOT IN ('CANCELLED','NO_SHOW')) AS occupied,
    (SELECT COALESCE(SUM(COALESCE(rr.sell_rate,r.nightly_rate)),0)
      FROM reservations r
      LEFT JOIN reservation_rate_nights rr
        ON rr.property_id=r.property_id AND rr.reservation_id=r.id AND rr.stay_date=d.stay_date
      WHERE r.property_id=pms_current_property_id()
        AND r.arrival_date<=d.stay_date AND r.departure_date>d.stay_date
        AND r.status NOT IN ('CANCELLED','NO_SHOW')) AS revenue
  FROM days d
)
SELECT
  (SELECT COUNT(*) FROM rooms WHERE property_id=pms_current_property_id() AND active) AS rooms,
  COALESCE(MAX(arrivals) FILTER (WHERE period='current'),0) AS current_arrivals,
  COALESCE(MAX(occupied) FILTER (WHERE period='current'),0) AS current_occupied,
  COALESCE(MAX(revenue) FILTER (WHERE period='current'),0) AS current_revenue,
  COALESCE(MAX(arrivals) FILTER (WHERE period='prior'),0) AS prior_arrivals,
  COALESCE(MAX(occupied) FILTER (WHERE period='prior'),0) AS prior_occupied,
  COALESCE(MAX(revenue) FILTER (WHERE period='prior'),0) AS prior_revenue
FROM daily`;

function dashboardMetrics(row: Record<string,unknown> | undefined, activeRooms: Array<Record<string,unknown>>) {
  const numeric=(value:unknown)=>{const parsed=Number(value??0);return Number.isFinite(parsed)?parsed:0;};
  const rooms=numeric(row?.rooms)||activeRooms.length;
  const current={arrivals:numeric(row?.current_arrivals),occupied:numeric(row?.current_occupied),revenue:numeric(row?.current_revenue)};
  const prior={arrivals:numeric(row?.prior_arrivals),occupied:numeric(row?.prior_occupied),revenue:numeric(row?.prior_revenue)};
  const occupancy=(occupied:number)=>rooms>0?occupied/rooms*100:0;
  const percentChange=(currentValue:number,priorValue:number)=>priorValue>0?(currentValue-priorValue)/priorValue*100:null;
  const currentOccupancy=occupancy(current.occupied),priorOccupancy=occupancy(prior.occupied);
  return {
    rooms,
    occupied:current.occupied,
    dirty:activeRooms.filter(item=>item.housekeeping_status==='DIRTY').length,
    ready:activeRooms.filter(item=>item.housekeeping_status==='CLEAN'||item.housekeeping_status==='INSPECTED').length,
    comparison:{
      current:{...current,occupancy:currentOccupancy,adr:current.occupied>0?current.revenue/current.occupied:0},
      prior:{...prior,occupancy:priorOccupancy,adr:prior.occupied>0?prior.revenue/prior.occupied:0},
      arrivalChangePercent:percentChange(current.arrivals,prior.arrivals),
      occupancyChangePoints:currentOccupancy-priorOccupancy,
      revenueChangePercent:percentChange(current.revenue,prior.revenue),
    },
  };
}

export async function snapshot(db: D1, principal?: Principal | null) {
  // The full snapshot is the compatibility contract for domain-heavy screens. It
  // favors one batched round trip and a mutually consistent read model over many
  // client requests that could observe different points in time.
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult,accountProfilesResult,blocksResult,blockInventoryResult,roomingResult,folioWindowsResult,folioEntriesResult,routingRulesResult,transactionCodesResult,arAccountsResult,arInvoicesResult,trialBalanceResult,channelConnectionsResult,channelContractsResult,channelMappingsResult,ariUpdatesResult,inboundMessagesResult,channelLinksResult,integrationAttemptsResult,outboxResult,comparisonResult] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id=pms_current_property_id() LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id=pms_current_property_id() GROUP BY r.id,g.id,rt.id,rm.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) WHERE rm.property_id=pms_current_property_id() ORDER BY rm.number`),
    principal ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email) : db.prepare("SELECT * FROM cashier_sessions WHERE FALSE"),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id=pms_current_property_id() AND business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id=pms_current_property_id() AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id=pms_current_property_id() AND business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id=pms_current_property_id() AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND r.departure_date>(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND f.kind='CHARGE' AND f.code='ROOM')"),
    db.prepare("SELECT * FROM room_types WHERE property_id=pms_current_property_id() ORDER BY code"),
    db.prepare("SELECT room_type_id, stay_date, COUNT(*) booked FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND ((SELECT business_date FROM properties WHERE id=pms_current_property_id()) + 13) GROUP BY room_type_id, stay_date"),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND ((SELECT business_date FROM properties WHERE id=pms_current_property_id()) + 13)"),
    db.prepare("SELECT * FROM account_profiles WHERE property_id=pms_current_property_id() AND active ORDER BY type,name"),
    db.prepare("SELECT bb.*,ap.name account_name,gp.name group_name,COALESCE(SUM(bi.original_rooms),0) original_room_nights,COALESCE(SUM(bi.current_rooms),0) current_room_nights,COALESCE(SUM(bi.picked_up),0) picked_up_room_nights FROM business_blocks bb LEFT JOIN account_profiles ap ON ap.id=bb.account_profile_id LEFT JOIN account_profiles gp ON gp.id=bb.group_profile_id LEFT JOIN block_inventory bi ON bi.block_id=bb.id WHERE bb.property_id=pms_current_property_id() GROUP BY bb.id,ap.id,gp.id ORDER BY bb.arrival_date,bb.code"),
    db.prepare("SELECT bi.*,rt.code room_type_code,rt.name room_type_name FROM block_inventory bi JOIN room_types rt ON rt.id=bi.room_type_id WHERE bi.property_id=pms_current_property_id() ORDER BY bi.block_id,bi.stay_date,rt.code"),
    db.prepare("SELECT rl.*,rt.code room_type_code,rt.name room_type_name FROM rooming_list_entries rl JOIN room_types rt ON rt.id=rl.room_type_id WHERE rl.property_id=pms_current_property_id() ORDER BY rl.block_id,rl.last_name,rl.first_name"),
    db.prepare(`SELECT w.*,g.first_name||' '||g.last_name guest_name,r.confirmation_no,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id LEFT JOIN folio_entries f ON f.id=d.entry_id WHERE w.property_id=pms_current_property_id() GROUP BY w.id,r.id,g.id ORDER BY r.updated_at DESC,w.window_no`),
    db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,d.currency,d.source_entry_id,d.reason,w.window_no,w.name window_name,r.confirmation_no,g.first_name||' '||g.last_name guest_name FROM folio_entries f LEFT JOIN folio_entry_details d ON d.entry_id=f.id LEFT JOIN folio_windows w ON w.id=d.folio_window_id JOIN reservations r ON r.id=f.reservation_id JOIN guests g ON g.id=r.guest_id WHERE f.property_id=pms_current_property_id() ORDER BY f.created_at DESC LIMIT 250"),
    db.prepare("SELECT rr.*,w.window_no,w.name window_name,r.confirmation_no FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id JOIN reservations r ON r.id=rr.reservation_id WHERE rr.property_id=pms_current_property_id() AND rr.active ORDER BY rr.created_at DESC"),
    db.prepare("SELECT * FROM transaction_codes WHERE property_id=pms_current_property_id() AND active ORDER BY category,code"),
    db.prepare("SELECT a.*,p.name profile_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_accounts a JOIN account_profiles p ON p.id=a.account_profile_id LEFT JOIN ar_ledger_entries l ON l.ar_account_id=a.id WHERE a.property_id=pms_current_property_id() GROUP BY a.id,p.id ORDER BY a.account_no"),
    db.prepare("SELECT i.*,a.account_no,a.name account_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i JOIN ar_accounts a ON a.id=i.ar_account_id LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id WHERE i.property_id=pms_current_property_id() GROUP BY i.id,a.id ORDER BY i.issued_date DESC,i.invoice_no DESC"),
    db.prepare(`SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) guest_ledger,(SELECT COALESCE(SUM(debit-credit),0) FROM ar_ledger_entries WHERE property_id=pms_current_property_id()) ar_ledger,COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount WHEN kind='CHARGE_REVERSAL' THEN -amount ELSE 0 END),0) gross_revenue,COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='PAYMENT_REVERSAL' THEN -amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0) net_payments FROM folio_entries WHERE property_id=pms_current_property_id()`),
    db.prepare("SELECT * FROM channel_connections WHERE property_id=pms_current_property_id() ORDER BY provider,name"),
    db.prepare("SELECT cc.*,c.provider,c.name connection_name FROM channel_contracts cc JOIN channel_connections c ON c.id=cc.connection_id WHERE cc.property_id=pms_current_property_id() ORDER BY c.provider,c.name"),
    db.prepare("SELECT m.*,c.provider,c.name connection_name,rt.code room_type_code,rt.name room_type_name FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id JOIN room_types rt ON rt.id=m.room_type_id WHERE m.property_id=pms_current_property_id() ORDER BY c.provider,rt.code,m.rate_plan"),
    db.prepare("SELECT a.*,c.provider,m.external_room_type_id,m.external_rate_plan_id,rt.code room_type_code FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id JOIN channel_mappings m ON m.id=a.mapping_id JOIN room_types rt ON rt.id=m.room_type_id WHERE a.property_id=pms_current_property_id() ORDER BY a.created_at DESC LIMIT 150"),
    db.prepare("SELECT i.*,c.name connection_name FROM inbound_channel_messages i JOIN channel_connections c ON c.id=i.connection_id WHERE i.property_id=pms_current_property_id() ORDER BY i.received_at DESC LIMIT 150"),
    db.prepare("SELECT l.*,c.provider,r.confirmation_no FROM channel_reservation_links l JOIN channel_connections c ON c.id=l.connection_id JOIN reservations r ON r.id=l.reservation_id WHERE l.property_id=pms_current_property_id() ORDER BY l.updated_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM integration_delivery_attempts WHERE property_id=pms_current_property_id() ORDER BY created_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM outbox_events WHERE property_id=pms_current_property_id() ORDER BY created_at DESC LIMIT 150"),
    db.prepare(DASHBOARD_COMPARISON_SQL),
  ]);
  const property = propertyResult.results[0] as Record<string,unknown>; const reservations=reservationResult.results as Array<Record<string,unknown>>; const rooms=roomResult.results as Array<Record<string,unknown>>;
  const activeRooms=rooms.filter(x=>x.active!==false); const metrics=dashboardMetrics(comparisonResult.results[0] as Record<string,unknown>|undefined,activeRooms);
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
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&room.active!==false&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`);const sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
  const groups={accounts:accountProfilesResult.results,blocks:blocksResult.results,inventory:blockInventoryResult.results,rooming:roomingResult.results};
  const finance={windows:folioWindowsResult.results,entries:folioEntriesResult.results,routing:routingRulesResult.results,transactionCodes:transactionCodesResult.results,arAccounts:arAccountsResult.results,arInvoices:arInvoicesResult.results,trialBalance:trialBalanceResult.results[0]??{guest_ledger:0,ar_ledger:0,gross_revenue:0,net_payments:0}};
  const integrations={connections:channelConnectionsResult.results,contracts:channelContractsResult.results,mappings:channelMappingsResult.results,ari:ariUpdatesResult.results,inbound:inboundMessagesResult.results,links:channelLinksResult.results,attempts:integrationAttemptsResult.results,outbox:outboxResult.results};
  return { property, reservations, rooms, metrics, principal, controls, inventory, groups, finance, integrations };
}

async function coreSnapshot(db:D1,principal:Principal) {
  // The core projection deliberately omits finance, groups, and integrations for
  // fast first paint; `completeness` prevents consumers from mistaking empty arrays
  // for authoritative domain data.
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult,comparisonResult]=await db.batch([
    db.prepare("SELECT * FROM properties WHERE id=pms_current_property_id() LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id=pms_current_property_id() GROUP BY r.id,g.id,rt.id,rm.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) WHERE rm.property_id=pms_current_property_id() ORDER BY rm.number`),
    db.prepare("SELECT * FROM cashier_sessions WHERE property_id=pms_current_property_id() AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id=pms_current_property_id() AND business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id=pms_current_property_id() AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id=pms_current_property_id() AND business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id=pms_current_property_id() AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND r.departure_date>(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND f.kind='CHARGE' AND f.code='ROOM')"),
    db.prepare("SELECT * FROM room_types WHERE property_id=pms_current_property_id() ORDER BY code"),
    db.prepare("SELECT room_type_id, stay_date, COUNT(*) booked FROM reservation_type_nights WHERE property_id=pms_current_property_id() AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND ((SELECT business_date FROM properties WHERE id=pms_current_property_id()) + 13) GROUP BY room_type_id, stay_date"),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id=pms_current_property_id() AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id=pms_current_property_id()) AND ((SELECT business_date FROM properties WHERE id=pms_current_property_id()) + 13)"),
    db.prepare(DASHBOARD_COMPARISON_SQL),
  ]);
  const property=propertyResult.results[0] as Record<string,unknown>,reservations=reservationResult.results as Array<Record<string,unknown>>,rooms=roomResult.results as Array<Record<string,unknown>>,activeRooms=rooms.filter(item=>item.active!==false);
  const metrics=dashboardMetrics(comparisonResult.results[0] as Record<string,unknown>|undefined,activeRooms);
  const arrivals=reservations.filter(item=>item.arrival_date===property.business_date&&item.status==='DUE_IN').length,cashiers=Number((openCashierResult.results[0] as {count?:number})?.count??0),failed=Number((failedResult.results[0] as {count?:number})?.count??0),oos=rooms.filter(item=>item.housekeeping_status==='OUT_OF_SERVICE').length;
  const blockers=[{code:"UNRESOLVED_ARRIVALS",label:"미처리 도착 예약",count:arrivals,blocking:true},{code:"OPEN_CASHIERS",label:"미마감 캐셔",count:cashiers,blocking:true},{code:"FAILED_INTERFACES",label:"인터페이스 전송 실패",count:failed,blocking:false},{code:"OUT_OF_SERVICE",label:"판매 중지 객실",count:oos,blocking:false}],priorAudit=auditResult.results[0]??null;
  const controls={blockers,canClose:blockers.every(item=>!item.blocking||item.count===0)&&!priorAudit,openCashier:actorCashierResult.results[0]??null,priorAudit,pendingRoomPostings:Number((postingsResult.results[0] as {count?:number})?.count??0)};
  const dates=Array.from({length:14},(_,index)=>{const day=new Date(`${String(property.business_date)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+index);return day.toISOString().slice(0,10)}),typeNights=typeNightsResult.results as Array<Record<string,unknown>>,controlRows=inventoryControlsResult.results as Array<Record<string,unknown>>,roomTypes=roomTypesResult.results as Array<Record<string,unknown>>,booked=new Map(typeNights.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.booked)])),inventoryControls=new Map(controlRows.map(row=>[`${row.room_type_id}:${row.stay_date}`,row]));
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&room.active!==false&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`),sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
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
export function invalidateSnapshots() { snapshotCache.clear(); coreSnapshotCache.clear(); snapshotRepresentationCache.clear(); coreRepresentationCache.clear(); reportCache.clear(); }
export async function cachedSnapshot(db:D1, principal:Principal) {
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
export async function cachedSnapshotResponse(db:D1,principal:Principal,request:Request) {
  const key=`${principal.propertyId}:${principal.email}`,now=Date.now();let cached=snapshotRepresentationCache.get(key);
  if(!cached||cached.expires<=now){const json=cachedSnapshot(db,principal).then(value=>JSON.stringify(value));cached={expires:now+3000,json,gzip:gzipSnapshot(json)};snapshotRepresentationCache.set(key,cached);}
  const common={"Cache-Control":"private, no-store","Content-Type":"application/json; charset=utf-8","Vary":"Accept-Encoding"};
  if(/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get("accept-encoding")||""))return new Response(await cached.gzip,{headers:{...common,"Content-Encoding":"gzip"}});
  return new Response(await cached.json,{headers:common});
}
export async function cachedCoreSnapshotResponse(db:D1,principal:Principal,request:Request){const key=`${principal.propertyId}:${principal.email}`,now=Date.now();let cached=coreRepresentationCache.get(key);if(!cached||cached.expires<=now){const json=cachedCoreSnapshot(db,principal).then(value=>JSON.stringify(value));cached={expires:now+3000,json,gzip:gzipSnapshot(json)};coreRepresentationCache.set(key,cached)}const common={"Cache-Control":"private, no-store","Content-Type":"application/json; charset=utf-8","Vary":"Accept-Encoding"};if(/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get("accept-encoding")||""))return new Response(await cached.gzip,{headers:{...common,"Content-Encoding":"gzip"}});return new Response(await cached.json,{headers:common})}
export async function cachedReport(db:D1,params:URLSearchParams,principal:Principal){const key=`${principal.propertyId}:${principal.email}:${params.toString()}`,now=Date.now(),cached=reportCache.get(key);if(cached&&cached.expires>now)return cached.value;if(reportCache.size>200){for(const [cacheKey,item] of reportCache)if(item.expires<=now)reportCache.delete(cacheKey);if(reportCache.size>200)reportCache.clear();}const value=runReport(db,params,principal);reportCache.set(key,{expires:now+5000,value});try{return await value;}catch(error){reportCache.delete(key);throw error;}}
