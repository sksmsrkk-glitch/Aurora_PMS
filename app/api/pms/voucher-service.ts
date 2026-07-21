/** Immutable reservation-voucher projection shared by preview, files, and email. */
import type { PmsDatabase } from "../../../db/pms-database";
import type { Principal } from "./auth";
import { PmsReadError } from "./frontdesk-read";

export type VoucherLanguage="KO"|"EN";
export type VoucherNight={stayDate:string;rate:number;currency:string;ratePlan:string};
export type VoucherPayload={
  language:VoucherLanguage;amountVisible:boolean;issuedAt:string;
  hotel:{name:string;code:string;address:string;phone:string;email:string;currency:string;checkinTime:string;checkoutTime:string};
  reservation:{id:string;confirmationNo:string;status:string;bookerName:string;bookerPhone:string;bookerEmail:string;guestName:string;guestPhone:string;guestEmail:string;arrivalDate:string;departureDate:string;nights:number;roomType:string;roomNumber:string;productName:string;productCode:string;mealPlan:string;adults:number;children:number;source:string;paymentType:string;guestRequest:string;inclusions:string[];cancellationPolicy:string;cancellationTerms:Array<{basis?:string;allowed?:boolean;feePercent?:number}>};
  rateNights:VoucherNight[];totalAmount:number;
};

const bool=(value:string|null,defaultValue=true)=>value==null?defaultValue:value==="true";
export function voucherLanguage(value:string|null):VoucherLanguage{return value==="EN"?"EN":"KO";}

/** Operational notes and card references are deliberately excluded from documents. */
export async function loadReservationVoucher(db:PmsDatabase,reservationId:string,params:URLSearchParams,principal:Principal):Promise<VoucherPayload>{
  const id=reservationId.trim().slice(0,80),language=voucherLanguage(params.get("language")),amountVisible=bool(params.get("showAmount"));
  if(!id)throw new PmsReadError(language==="EN"?"Reservation identifier is required.":"예약 식별자가 필요합니다.");
  const [detailResult,nightResult]=await db.batch([
    db.prepare(`SELECT r.*,p.name property_name,p.code property_code,p.currency,
        COALESCE(ws.address,'') property_address,COALESCE(ws.phone,'') property_phone,COALESCE(ws.email,'') property_email,
        COALESCE(ws.checkin_time::text,'15:00') checkin_time,COALESCE(ws.checkout_time::text,'11:00') checkout_time,
        g.first_name,g.last_name,g.email guest_email,g.phone guest_phone,
        rt.code room_type_code,rt.name room_type_name,rm.number room_number,
        COALESCE(r.rate_plan_snapshot->>'code',rp.code,r.rate_plan) product_code,
        COALESCE(r.rate_plan_snapshot->>'name',rp.name,r.channel_product_name,r.rate_plan) product_name,
        COALESCE(r.rate_plan_snapshot->>'mealPlan',rp.meal_plan,'ROOM_ONLY') meal_plan,
        COALESCE(r.rate_plan_snapshot->'inclusions',rp.inclusions,'[]'::jsonb) inclusions,
        COALESCE(r.rate_plan_snapshot->>'cancellationPolicy',rp.cancellation_policy,'') cancellation_policy,
        COALESCE(r.rate_plan_snapshot->'cancellationTerms',rp.cancellation_terms,'[]'::jsonb) cancellation_terms
      FROM reservations r JOIN properties p ON p.id=r.property_id
      JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id
      JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id
      LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id
      LEFT JOIN rate_plans rp ON rp.id=r.rate_plan_id AND rp.property_id=r.property_id
      LEFT JOIN website_settings ws ON ws.property_id=r.property_id
      WHERE r.property_id=pms_current_property_id() AND r.id=? LIMIT 1`).bind(id),
    db.prepare("SELECT stay_date,sell_rate,currency,rate_plan FROM reservation_rate_nights WHERE property_id=pms_current_property_id() AND reservation_id=? ORDER BY stay_date").bind(id),
  ]);
  const row=detailResult.results[0];if(!row)throw new PmsReadError(language==="EN"?"Reservation not found.":"예약을 찾지 못했습니다.",404);
  const masked=principal.piiMode==="MASKED",rateNights=nightResult.results.map(item=>({stayDate:String(item.stay_date),rate:Number(item.sell_rate),currency:String(item.currency),ratePlan:String(item.rate_plan)}));
  const guestName=masked?`${String(row.first_name||"").slice(0,1)}** ${String(row.last_name||"").slice(0,1)}**`:`${row.first_name} ${row.last_name}`.trim();
  return {language,amountVisible,issuedAt:new Date().toISOString(),hotel:{name:String(row.property_name),code:String(row.property_code),address:String(row.property_address),phone:String(row.property_phone),email:String(row.property_email),currency:String(row.currency),checkinTime:String(row.checkin_time).slice(0,5),checkoutTime:String(row.checkout_time).slice(0,5)},reservation:{id:String(row.id),confirmationNo:String(row.confirmation_no),status:String(row.status),bookerName:masked?`${String(row.booker_name||"").slice(0,1)}**`:String(row.booker_name),bookerPhone:masked?"***-****-****":String(row.booker_phone||""),bookerEmail:masked?"masked@support.invalid":String(row.booker_email||""),guestName,guestPhone:masked?"***-****-****":String(row.guest_phone||""),guestEmail:masked?"masked@support.invalid":String(row.guest_email||""),arrivalDate:String(row.arrival_date),departureDate:String(row.departure_date),nights:rateNights.length,roomType:`${row.room_type_code} · ${row.room_type_name}`,roomNumber:String(row.room_number||""),productName:String(row.product_name),productCode:String(row.product_code),mealPlan:String(row.meal_plan),adults:Number(row.adults),children:Number(row.children),source:String(row.source),paymentType:String(row.payment_type),guestRequest:masked?(language==="EN"?"Masked for support access":"지원 조회에서 마스킹됨"):String(row.guest_request||""),inclusions:Array.isArray(row.inclusions)?row.inclusions.map(String):[],cancellationPolicy:String(row.cancellation_policy||""),cancellationTerms:Array.isArray(row.cancellation_terms)?row.cancellation_terms as VoucherPayload["reservation"]["cancellationTerms"]:[]},rateNights,totalAmount:rateNights.reduce((sum,item)=>sum+item.rate,0)};
}
