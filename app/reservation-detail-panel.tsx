"use client";

/** HotelStory-style operational reservation detail loaded only for the open row. */
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";
import { addIsoDays, formatMoney } from "../lib/format";
import { usePmsActions } from "./pms-action-context";

type Summary = {
  id:string;confirmation_no:string;version:number;status:string;arrival_date:string;departure_date:string;
  first_name:string;last_name:string;room_type_id:string;rate_plan:string;nightly_rate:number;eta:string|null;
};
type DetailRow = Summary & Record<string,unknown> & {
  property_name:string;property_code:string;source:string;room_number:string|null;room_type_code:string;room_type_name:string;
  booker_name:string;booker_phone:string|null;booker_email:string|null;guest_phone:string|null;guest_email:string|null;
  channel_product_name:string|null;product_code:string;product_name:string;meal_plan:string;package_type:string;
  payment_type:string;adults:number;children:number;guest_request:string;guest_request_response:string;
  manager_memo:string;hotel_memo:string;reservation_checked:boolean;early_checkin:boolean;early_checkin_time:string|null;
  late_checkout:boolean;late_checkout_time:string|null;card_info_ref:string|null;service_fee_included:boolean;
  cancellation_policy:string;cancellation_terms:Array<{basis?:string;allowed?:boolean;feePercent?:number}>;inclusions:string[];
};
type LogRow={id:string;actor:string;action:string;entity_type:string;before_json:unknown;after_json:unknown;created_at:string};
type Payload={reservation:DetailRow;rateNights:Array<{stay_date:string;sell_rate:number;currency:string;rate_plan:string}>;links:Array<{id:string;relation_type:string;confirmation_no:string;arrival_date:string;departure_date:string;status:string;first_name:string;last_name:string}>;logs:Record<"integration"|"edits"|"rates"|"blocks",LogRow[]>;error?:string};
type FormState={
  bookerName:string;bookerPhone:string;bookerEmail:string;guestFirstName:string;guestLastName:string;guestPhone:string;guestEmail:string;
  adults:string;children:string;channelProductName:string;paymentType:string;guestRequest:string;guestRequestResponse:string;
  managerMemo:string;hotelMemo:string;reservationChecked:boolean;earlyCheckin:boolean;earlyCheckinTime:string;
  lateCheckout:boolean;lateCheckoutTime:string;cardInfoRef:string;serviceFeeIncluded:boolean;
};
type PanelProps={summary:Summary;onEdit:()=>void;onAssign:()=>void;onCancel:()=>void;canEdit:boolean;canAssign:boolean;canCancel:boolean;canExport:boolean};

const ReservationVoucherDialog=dynamic(()=>import("./reservation-voucher-dialog"));

const mealLabels:Record<string,string>={ROOM_ONLY:"식사 미포함",BREAKFAST:"조식 포함",DINNER:"석식 포함",HALF_BOARD:"조식·석식 포함",FULL_PACKAGE:"24시간 풀패키지"};
const relationLabels:Record<string,string>={COMPANION:"동반 예약",CONSECUTIVE:"연박 예약",GROUP:"그룹 예약"};
const logTabs=[{key:"integration",label:"연동로그"},{key:"edits",label:"수정로그"},{key:"rates",label:"요금로그"},{key:"blocks",label:"블럭로그"}] as const;

function formFrom(detail:DetailRow):FormState{return {
  bookerName:String(detail.booker_name||""),bookerPhone:String(detail.booker_phone||""),bookerEmail:String(detail.booker_email||""),
  guestFirstName:String(detail.first_name||""),guestLastName:String(detail.last_name||""),guestPhone:String(detail.guest_phone||""),guestEmail:String(detail.guest_email||""),
  adults:String(detail.adults),children:String(detail.children),channelProductName:String(detail.channel_product_name||detail.product_name||""),paymentType:String(detail.payment_type||"HOTEL"),
  guestRequest:String(detail.guest_request||""),guestRequestResponse:String(detail.guest_request_response||""),managerMemo:String(detail.manager_memo||""),hotelMemo:String(detail.hotel_memo||""),
  reservationChecked:Boolean(detail.reservation_checked),earlyCheckin:Boolean(detail.early_checkin),earlyCheckinTime:String(detail.early_checkin_time||"" ).slice(0,5),
  lateCheckout:Boolean(detail.late_checkout),lateCheckoutTime:String(detail.late_checkout_time||"").slice(0,5),cardInfoRef:String(detail.card_info_ref||""),serviceFeeIncluded:Boolean(detail.service_fee_included),
};}

function compactAudit(value:unknown){
  if(!value||typeof value!=="object")return "기록 없음";
  return Object.entries(value as Record<string,unknown>).slice(0,8).map(([key,item])=>`${key}: ${typeof item==="object"?JSON.stringify(item):String(item)}`).join(" · ");
}

export default function ReservationDetailPanel(props:PanelProps){
  const {summary}=props;
  const detailQuery=useQuery({queryKey:["pms","reservation-detail",summary.id],queryFn:async()=>{const response=await fetch(`/api/pms?view=reservation_detail&reservationId=${encodeURIComponent(summary.id)}`,{cache:"no-store"}),json=await response.json() as Payload;if(!response.ok)throw new Error(json.error||"예약 상세를 불러오지 못했습니다.");return json;},staleTime:5_000});
  if(detailQuery.isLoading)return <div className="reservation-detail-state"><b>예약 원장을 불러오고 있습니다</b><p>투숙자, 일자별 요금과 변경 이력을 확인하고 있어요.</p></div>;
  if(detailQuery.error||!detailQuery.data)return <div className="report-error" role="alert">{detailQuery.error instanceof Error?detailQuery.error.message:"예약 상세를 불러오지 못했습니다."}</div>;
  return <ReservationDetailLoaded key={`${summary.id}:${detailQuery.data.reservation.version}`} {...props} data={detailQuery.data} refresh={async()=>{await detailQuery.refetch();}}/>;
}

function ReservationDetailLoaded({summary,onEdit,onAssign,onCancel,canEdit,canAssign,canCancel,canExport,data,refresh}:PanelProps&{data:Payload;refresh:()=>Promise<void>}){
  const {busy,act}=usePmsActions();
  const [form,setForm]=useState<FormState>(()=>formFrom(data.reservation)),[logTab,setLogTab]=useState<(typeof logTabs)[number]["key"]>("edits"),[modal,setModal]=useState<"link"|"copy"|"voucher"|null>(null);
  const [link,setLink]=useState({linkedConfirmationNo:"",relationType:"COMPANION",notes:""});
  const [copy,setCopy]=useState({arrivalDate:summary.arrival_date,departureDate:summary.departure_date});
  const detail=data.reservation,set=(key:keyof FormState,value:string|boolean)=>setForm(current=>({...current,[key]:value}));
  const submit=async()=>{const ok=await act("update_reservation_detail",{reservationId:detail.id,expectedVersion:String(detail.version),...Object.fromEntries(Object.entries(form).map(([key,value])=>[key,String(value)]))});if(ok)await refresh();};
  const submitLink=async()=>{if(await act("link_reservation",{reservationId:detail.id,...link})){setModal(null);setLink({linkedConfirmationNo:"",relationType:"COMPANION",notes:""});await refresh();}};
  const submitCopy=async()=>{const ok=await act("create_reservation",{firstName:form.guestFirstName,lastName:form.guestLastName,email:form.guestEmail,phone:form.guestPhone,bookerName:form.bookerName,bookerEmail:form.bookerEmail,bookerPhone:form.bookerPhone,arrivalDate:copy.arrivalDate,departureDate:copy.departureDate,roomTypeId:detail.room_type_id,ratePlan:detail.product_code||detail.rate_plan,nightlyRate:String(detail.nightly_rate),rateOverride:"false",adults:form.adults,children:form.children,source:"Copy",eta:detail.eta||"",notes:`복사 원본 ${detail.confirmation_no}`,guestRequest:form.guestRequest,paymentType:form.paymentType,nationality:String(detail.nationality||"KR")});if(ok)setModal(null);};
  return <div className="reservation-operational-detail">
    <div className="reservation-detail-toolbar"><div><b>{detail.reservation_checked?"✓ 예약 확인 완료":"! 예약 확인 필요"}</b><span>{detail.property_name} · {detail.source} · {detail.payment_type}</span></div><div><button type="button" className="voucher-open" onClick={()=>setModal("voucher")}>예약 바우처</button>{canEdit&&<button type="button" onClick={onEdit}>예약변경</button>}<button type="button" onClick={()=>setModal("link")}>연계예약</button><button type="button" onClick={()=>{setCopy({arrivalDate:detail.arrival_date,departureDate:detail.departure_date});setModal("copy");}}>예약복사</button></div></div>
    <div className="reservation-detail-columns">
      <section className="reservation-facts"><header><span>예약 정보</span><b>{detail.product_name||detail.rate_plan}</b></header><dl>
        <div><dt>호텔 / 코드</dt><dd>{detail.property_name} · {detail.property_code}</dd></div><div><dt>채널 상품</dt><dd>{form.channelProductName||"미지정"}</dd></div>
        <div><dt>H 객실코드</dt><dd>{detail.room_type_code} · {detail.room_type_name}</dd></div><div><dt>H 상품코드</dt><dd>{detail.product_code||detail.rate_plan}</dd></div>
        <div><dt>숙박</dt><dd>{detail.arrival_date} → {detail.departure_date} · {data.rateNights.length}박</dd></div><div><dt>판매 채널</dt><dd>{detail.source}</dd></div>
        <div><dt>결제 구분</dt><dd>{detail.payment_type}</dd></div><div><dt>식사</dt><dd>{mealLabels[detail.meal_plan]||detail.meal_plan}</dd></div>
      </dl><h4>일자별 요금</h4><div className="reservation-rate-table"><div><b>투숙일자</b><b>상품</b><b>판매가</b></div>{data.rateNights.map(night=><div key={night.stay_date}><span>{night.stay_date}</span><span>{night.rate_plan}</span><strong>{formatMoney(Number(night.sell_rate))}</strong></div>)}</div>
      <h4>예약 시점 취소 규정</h4><p className="policy-summary">{detail.cancellation_policy}</p><div className="cancellation-table"><div><b>취소일 기준</b><b>가능 여부</b><b>수수료율</b><b>수수료</b></div>{detail.cancellation_terms.map((term,index)=><div key={`${term.basis}-${index}`}><span>{term.basis||"정책 기준"}</span><span>{term.allowed?"취소 가능":"취소 제한"}</span><span>{Number(term.feePercent||0)}%</span><strong>{formatMoney(data.rateNights.reduce((sum,row)=>sum+Number(row.sell_rate),0)*Number(term.feePercent||0)/100)}</strong></div>)}</div>
      {data.links.length>0&&<><h4>연계 예약</h4><div className="linked-reservations">{data.links.map(item=><article key={item.id}><b>{relationLabels[item.relation_type]||item.relation_type} · {item.confirmation_no}</b><span>{item.first_name} {item.last_name} · {item.arrival_date} → {item.departure_date}</span></article>)}</div></>}
      </section>
      <form className="reservation-people" onSubmit={event=>{event.preventDefault();void submit();}}><header><span>예약자와 투숙자</span><b>서로 달라도 저장됩니다</b></header><div className="person-grid"><fieldset><legend>예약자</legend><label><span>예약자명</span><input required maxLength={120} value={form.bookerName} onChange={event=>set("bookerName",event.target.value)}/></label><label><span>연락처</span><input maxLength={40} value={form.bookerPhone} onChange={event=>set("bookerPhone",event.target.value)}/></label><label><span>이메일</span><input type="email" maxLength={254} value={form.bookerEmail} onChange={event=>set("bookerEmail",event.target.value)}/></label></fieldset><fieldset><legend>투숙자</legend><div className="split"><label><span>이름</span><input required value={form.guestFirstName} onChange={event=>set("guestFirstName",event.target.value)}/></label><label><span>성</span><input required value={form.guestLastName} onChange={event=>set("guestLastName",event.target.value)}/></label></div><label><span>연락처</span><input value={form.guestPhone} onChange={event=>set("guestPhone",event.target.value)}/></label><label><span>이메일</span><input type="email" value={form.guestEmail} onChange={event=>set("guestEmail",event.target.value)}/></label></fieldset></div>
      <div className="reservation-option-grid"><label><span>성인</span><select value={form.adults} onChange={event=>set("adults",event.target.value)}>{Array.from({length:20},(_,index)=><option value={index+1} key={index+1}>{index+1}명</option>)}</select></label><label><span>소인</span><select value={form.children} onChange={event=>set("children",event.target.value)}>{Array.from({length:13},(_,index)=><option value={index} key={index}>{index}명</option>)}</select></label><label><span>결제 구분</span><select value={form.paymentType} onChange={event=>set("paymentType",event.target.value)}><option value="HOTEL">호텔 결제</option><option value="PREPAID">선결제</option><option value="CHANNEL">채널 결제</option><option value="DIRECT_BILL">후불</option></select></label><label><span>채널 상품명</span><input value={form.channelProductName} onChange={event=>set("channelProductName",event.target.value)}/></label></div>
      <label><span>고객요청</span><textarea maxLength={2000} value={form.guestRequest} onChange={event=>set("guestRequest",event.target.value)}/></label><label><span>고객요청 응답</span><textarea maxLength={2000} value={form.guestRequestResponse} onChange={event=>set("guestRequestResponse",event.target.value)}/></label><div className="split"><label><span>관리자메모</span><textarea maxLength={2000} value={form.managerMemo} onChange={event=>set("managerMemo",event.target.value)}/></label><label><span>호텔메모</span><textarea maxLength={2000} value={form.hotelMemo} onChange={event=>set("hotelMemo",event.target.value)}/></label></div>
      <div className="reservation-checks"><label><input type="checkbox" checked={form.reservationChecked} onChange={event=>set("reservationChecked",event.target.checked)}/><span>예약 확인 완료</span></label><label><input type="checkbox" checked={form.serviceFeeIncluded} onChange={event=>set("serviceFeeIncluded",event.target.checked)}/><span>서비스 요금 포함</span></label></div>
      <div className="extension-grid"><label><span><input type="checkbox" checked={form.earlyCheckin} onChange={event=>set("earlyCheckin",event.target.checked)}/> 얼리체크인</span><input type="time" disabled={!form.earlyCheckin} required={form.earlyCheckin} value={form.earlyCheckinTime} onChange={event=>set("earlyCheckinTime",event.target.value)}/></label><label><span><input type="checkbox" checked={form.lateCheckout} onChange={event=>set("lateCheckout",event.target.checked)}/> 레이트체크아웃</span><input type="time" disabled={!form.lateCheckout} required={form.lateCheckout} value={form.lateCheckoutTime} onChange={event=>set("lateCheckoutTime",event.target.value)}/></label></div>
      <label><span>Card Info · 토큰/마스킹 참조만</span><input maxLength={160} value={form.cardInfoRef} onChange={event=>set("cardInfoRef",event.target.value)} placeholder="PG token 또는 ****1234 (원문 카드번호 저장 금지)"/></label>
      <div className="reservation-detail-actions">{canCancel&&<button type="button" className="secondary danger" onClick={onCancel}>취소접수</button>}{canAssign&&<button type="button" className="secondary" onClick={onAssign}>{detail.room_number?"객실 변경":"객실 배정"}</button>}<button className="primary" disabled={!!busy}>{busy?"저장 중…":"예약 상세 저장"}</button></div></form>
    </div>
    <section className="reservation-inline-logs"><div role="tablist" aria-label="예약 이력">{logTabs.map(tab=><button type="button" role="tab" aria-selected={logTab===tab.key} className={logTab===tab.key?"on":""} key={tab.key} onClick={()=>setLogTab(tab.key)}>{tab.label}<b>{tab.key==="rates"?data.logs.rates.length+data.rateNights.length:data.logs[tab.key].length}</b></button>)}</div>{logTab==="rates"&&data.rateNights.map(row=><article key={`night-${row.stay_date}`}><time>{row.stay_date}</time><div><b>예약 시점 일자 요금</b><p>{row.rate_plan} · {formatMoney(Number(row.sell_rate))}</p></div><span>IMMUTABLE</span></article>)}{data.logs[logTab].map(row=><article key={row.id}><time>{new Date(row.created_at).toLocaleString("ko-KR")}</time><div><b>{row.action}</b><p>{compactAudit(row.after_json||row.before_json)}</p></div><span>{row.actor}</span></article>)}{data.logs[logTab].length===0&&(logTab!=="rates"||data.rateNights.length===0)&&<div className="empty-state"><b>기록이 없습니다.</b><p>이 예약의 해당 업무 이력이 생기면 이곳에 표시됩니다.</p></div>}</section>
    {modal==="link"&&<div className="modal-backdrop"><form className="cashier-modal" onSubmit={event=>{event.preventDefault();void submitLink();}}><div className="drawer-head"><div><p>{detail.confirmation_no}</p><h2>연계 예약 등록</h2></div><button type="button" onClick={()=>setModal(null)}>×</button></div><div className="stack-form"><label><span>연계할 예약번호</span><input required value={link.linkedConfirmationNo} onChange={event=>setLink({...link,linkedConfirmationNo:event.target.value})}/></label><label><span>연계 유형</span><select value={link.relationType} onChange={event=>setLink({...link,relationType:event.target.value})}><option value="COMPANION">동반 예약</option><option value="CONSECUTIVE">연박 예약</option><option value="GROUP">그룹 예약</option></select></label><label><span>메모</span><textarea value={link.notes} onChange={event=>setLink({...link,notes:event.target.value})}/></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>닫기</button><button className="primary" disabled={!!busy}>연계 저장</button></div></form></div>}
    {modal==="copy"&&<div className="modal-backdrop"><form className="cashier-modal" onSubmit={event=>{event.preventDefault();void submitCopy();}}><div className="drawer-head"><div><p>{detail.confirmation_no}에서 복사</p><h2>예약 복사</h2></div><button type="button" onClick={()=>setModal(null)}>×</button></div><p className="form-intro">투숙자·예약자·상품을 복사하고 새 일정의 판매 조건과 재고는 서버에서 다시 검증합니다.</p><div className="form-grid"><label><span>새 도착일</span><input type="date" required value={copy.arrivalDate} onChange={event=>setCopy({arrivalDate:event.target.value,departureDate:event.target.value>=copy.departureDate?addIsoDays(event.target.value,1):copy.departureDate})}/></label><label><span>새 출발일</span><input type="date" min={addIsoDays(copy.arrivalDate,1)} required value={copy.departureDate} onChange={event=>setCopy({...copy,departureDate:event.target.value})}/></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(null)}>닫기</button><button className="primary" disabled={!!busy}>재고 확인 후 복사</button></div></form></div>}
    {modal==="voucher"&&<ReservationVoucherDialog reservationId={detail.id} confirmationNo={detail.confirmation_no} defaultEmail={form.bookerEmail||form.guestEmail} canExport={canExport} close={()=>setModal(null)}/>}
  </div>;
}
