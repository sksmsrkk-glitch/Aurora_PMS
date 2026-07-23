"use client";

/** Availability-first staff reservation wizard with a persistent price summary. */

import { useMemo, useState } from "react";
import { addIsoDays, formatMoney } from "../lib/format";
import { reservationOfferMatchesSearch } from "../lib/pms-search";
import { usePmsActions } from "./pms-action-context";

type Room = { id: string; number: string; room_type_id: string; front_desk_status: string; housekeeping_status: string; active: boolean };
type Plan = { id: string; code: string; name: string; description:string; cancellationPolicy: string; mealPlan: string; guaranteePolicy: string; packageType:string; inclusions:string[]; baseOccupancy:number; maxOccupancy:number; total: number; average: number; nights: Array<{ date: string; rate: number; available: number }> };
type Offer = { roomTypeId: string; code: string; name: string; capacity: number; available: number; plans: Plan[] };
type Availability = { property: { name: string; currency: string; businessDate: string }; search: { arrival: string; departure: string; adults: number; children: number; nights: number }; offers: Offer[]; error?: string };
type CalendarData={property:{name:string;currency:string;businessDate:string};month:string;dates:string[];adults:number;children:number;products:Array<Pick<Plan,"id"|"code"|"name"|"mealPlan"|"packageType"|"baseOccupancy"|"maxOccupancy">>;selectedProduct:CalendarData["products"][number]|null;rows:Array<{roomTypeId:string;code:string;name:string;capacity:number;physical:number;cells:Array<{date:string;available:number;total:number;rate:number|null;closed:boolean}>}>;error?:string};

const steps = ["일정·인원", "객실·요금", "고객·결제", "검토·확정"];
const offersPerPage = 5;
const mealPlanLabels:Record<string,string>={ROOM_ONLY:"미포함",BREAKFAST:"조식 포함",DINNER:"석식 포함",HALF_BOARD:"조식·석식",FULL_PACKAGE:"풀패키지"};
const mealPlanLabel=(value:string)=>mealPlanLabels[value]||value;
function shiftMonth(value:string,delta:number){const date=new Date(`${value}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+delta);return date.toISOString().slice(0,7);}

/** One resolver feeds both the review total and the mutation payload. */
export function reservationPriceInput(value: string, average: number) {
  const nightlyRate = value.trim() === "" ? average : Number(value);
  return {
    nightlyRate,
    rateOverride: nightlyRate !== average,
  };
}

export function reservationDisplayedTotal(
  value: string,
  plan: Pick<Plan, "average" | "total">,
  nights: number,
) {
  const price = reservationPriceInput(value, plan.average);
  return price.rateOverride ? price.nightlyRate * nights : plan.total;
}

/** Keeps high-cardinality hotel masters out of the reservation dialog DOM. */
export function reservationOfferWindow(offers: Offer[], query: string, page: number) {
  const filteredOffers = offers.filter((entry) =>
    reservationOfferMatchesSearch(entry, query),
  );
  const pageCount = Math.max(1, Math.ceil(filteredOffers.length / offersPerPage));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  return { filteredOffers, pageCount, safePage, visibleOffers: filteredOffers.slice(safePage * offersPerPage, (safePage + 1) * offersPerPage) };
}

/** Maps UI field names to the strict command contract; dates must never be sent as arrival/departure aliases. */
export function reservationCommandInput(
  search:{arrival:string;departure:string;adults:string;children:string},
  guest:Record<string,string>,roomTypeId:string,ratePlan:string,average:number,
) {
  const price=reservationPriceInput(guest.nightlyRate||"",average);
  return {...guest,arrivalDate:search.arrival,departureDate:search.departure,adults:search.adults,children:search.children,roomTypeId,ratePlan,nightlyRate:String(price.nightlyRate),rateOverride:String(price.rateOverride)};
}

export default function ReservationWizard({ rooms, businessDate, initial={}, close }: { rooms: Room[]; businessDate: string; initial?:{arrivalDate?:string;roomTypeId?:string;roomId?:string}; close: () => void }) {
  const { busy, act } = usePmsActions();
  const [step, setStep] = useState(0);
  const initialArrival=initial.arrivalDate&&initial.arrivalDate>=businessDate?initial.arrivalDate:businessDate;
  const [search, setSearch] = useState({ arrival: initialArrival, departure: addIsoDays(initialArrival, 1), adults: "2", children: "0" });
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [offerId, setOfferId] = useState("");
  const [planId, setPlanId] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [offerQuery, setOfferQuery] = useState("");
  const [offerPage, setOfferPage] = useState(0);
  const [bookingMode,setBookingMode]=useState<"LIST"|"CALENDAR">("LIST");
  const [calendarMonth,setCalendarMonth]=useState(businessDate.slice(0,7));
  const [calendarProduct,setCalendarProduct]=useState("");
  const [calendarData,setCalendarData]=useState<CalendarData|null>(null);
  const [calendarLoading,setCalendarLoading]=useState(false);
  const [guest, setGuest] = useState({ firstName: "", lastName: "", email: "", phone: "", source: "Direct", eta: "15:00", roomId: "", notes: "", nationality: "KR", nightlyRate: "" });
  const offer = availability?.offers.find((entry) => entry.roomTypeId === offerId) || null;
  const plan = offer?.plans.find((entry) => entry.id === planId) || null;
  const displayedTotal = plan
    ? reservationDisplayedTotal(guest.nightlyRate,plan,Number(availability?.search.nights||1))
    : 0;
  const assignableRooms = useMemo(() => rooms.filter((room) => room.active && room.room_type_id === offerId && room.front_desk_status === "VACANT" && ["CLEAN", "INSPECTED"].includes(room.housekeeping_status)), [offerId, rooms]);
  const offerWindow = useMemo(() => reservationOfferWindow(availability?.offers ?? [], offerQuery, offerPage), [availability, offerQuery, offerPage]);
  const { filteredOffers, pageCount: offerPageCount, safePage, visibleOffers } = offerWindow;
  const setGuestField = (key: keyof typeof guest, value: string) => setGuest((current) => ({ ...current, [key]: value }));
  async function findAvailability(criteria=search,preferredPlanId="") {
    setSearching(true); setError("");
    try {
      const params = new URLSearchParams({ view: "reservation_availability", ...criteria });
      const response = await fetch(`/api/pms?${params}`, { cache: "no-store" });
      const json = (await response.json()) as Availability;
      if (!response.ok) throw new Error(json.error || "가용 객실을 찾지 못했습니다.");
      const preferredOffer=json.offers.find(entry=>entry.plans.some(rate=>rate.id===preferredPlanId))||json.offers.find(entry=>entry.roomTypeId===initial.roomTypeId),preferredPlan=preferredOffer?.plans.find(rate=>rate.id===preferredPlanId)||preferredOffer?.plans[0];
      setSearch(criteria);setAvailability(json);setOfferId(preferredOffer?.roomTypeId||"");setPlanId(preferredPlan?.id||"");setOfferQuery("");setOfferPage(0);setGuestField("nightlyRate",preferredPlan?String(preferredPlan.average):"");setGuestField("roomId",initial.roomId&&rooms.some(room=>room.id===initial.roomId)?initial.roomId:"");setStep(1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "가용 객실을 찾지 못했습니다."); }
    finally { setSearching(false); }
  }
  async function findCalendar(month=calendarMonth,ratePlanId=calendarProduct) {
    setCalendarLoading(true);setError("");
    try{
      const params=new URLSearchParams({view:"reservation_calendar",month,adults:search.adults,children:search.children});
      if(ratePlanId)params.set("ratePlanId",ratePlanId);
      const response=await fetch(`/api/pms?${params}`,{cache:"no-store"}),json=(await response.json()) as CalendarData;
      if(!response.ok)throw new Error(json.error||"예약 달력을 불러오지 못했습니다.");
      setCalendarData(json);setCalendarMonth(month);setCalendarProduct(json.selectedProduct?.id||"");
    }catch(reason){setError(reason instanceof Error?reason.message:"예약 달력을 불러오지 못했습니다.");}
    finally{setCalendarLoading(false);}
  }
  function selectPlan(nextOffer: Offer, nextPlan: Plan) {
    setOfferId(nextOffer.roomTypeId); setPlanId(nextPlan.id); setGuestField("nightlyRate", String(nextPlan.average)); setGuestField("roomId", "");
  }
  async function confirmReservation() {
    if (!offer || !plan || !confirmed) return;
    const ok = await act("create_reservation",reservationCommandInput(search,guest,offer.roomTypeId,plan.code,plan.average));
    if (ok) close();
  }
  return <div className="modal-backdrop reservation-wizard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-label="새 예약 만들기" className="reservation-wizard">
      <header className="wizard-header"><div><p>NEW RESERVATION</p><h2>새 예약 만들기</h2></div><button type="button" aria-label="팝업 닫기" onClick={close}>×</button></header>
      <ol className="wizard-steps">{steps.map((label, index) => <li className={index === step ? "active" : index < step ? "done" : ""} key={label}><i>{index < step ? "✓" : index + 1}</i><span>{label}</span></li>)}</ol>
      <div className="wizard-layout">
        <div className="wizard-main">
          {step === 0 && <section className="wizard-section">
            <div className="wizard-section-title"><span>1</span><div><h3>언제, 몇 분이 투숙하나요?</h3><p>재고와 모든 활성 요금제를 호텔 영업일 기준으로 확인합니다.</p></div></div>
            <div className="booking-mode-tabs" role="tablist" aria-label="예약 조회 방식"><button type="button" role="tab" aria-selected={bookingMode==="LIST"} className={bookingMode==="LIST"?"on":""} onClick={()=>setBookingMode("LIST")}>목록으로 찾기</button><button type="button" role="tab" aria-selected={bookingMode==="CALENDAR"} className={bookingMode==="CALENDAR"?"on":""} onClick={()=>{setBookingMode("CALENDAR");if(!calendarData)void findCalendar();}}>달력으로 찾기</button></div>
            {bookingMode==="LIST"?<form className="booking-list-search" onSubmit={(event)=>{event.preventDefault();void findAvailability();}}>
              <div className="form-grid"><label><span>도착일</span><input type="date" min={businessDate} required value={search.arrival} onChange={(event) => setSearch({ ...search, arrival: event.target.value, departure: event.target.value >= search.departure ? addIsoDays(event.target.value, 1) : search.departure })} /></label><label><span>출발일</span><input type="date" min={addIsoDays(search.arrival, 1)} required value={search.departure} onChange={(event) => setSearch({ ...search, departure: event.target.value })} /></label><label><span>성인</span><input type="number" min="1" max="20" required value={search.adults} onChange={(event) => setSearch({ ...search, adults: event.target.value })} /></label><label><span>아동</span><input type="number" min="0" max="12" required value={search.children} onChange={(event) => setSearch({ ...search, children: event.target.value })} /></label></div>
              <div className="wizard-actions"><button type="button" className="secondary" onClick={close}>취소</button><button className="primary" disabled={searching}>{searching ? "재고·요금 확인 중…" : "가용 객실 조회"}</button></div>
            </form>:<div className="booking-calendar-panel">
              <div className="booking-calendar-filters"><label><span>성인</span><input type="number" min="1" max="20" value={search.adults} onChange={event=>setSearch({...search,adults:event.target.value})}/></label><label><span>아동</span><input type="number" min="0" max="12" value={search.children} onChange={event=>setSearch({...search,children:event.target.value})}/></label><label className="product"><span>판매 상품</span><select value={calendarProduct} disabled={calendarLoading} onChange={event=>{setCalendarProduct(event.target.value);void findCalendar(calendarMonth,event.target.value)}}>{calendarData?.products.map(product=><option key={product.id} value={product.id}>{product.code} · {product.name}</option>)}</select></label><button type="button" className="secondary" disabled={calendarLoading} onClick={()=>void findCalendar(calendarMonth,calendarProduct)}>인원 적용</button></div>
              <div className="booking-calendar-nav"><button type="button" aria-label="이전 달" onClick={()=>void findCalendar(shiftMonth(calendarMonth,-1),calendarProduct)}>‹</button><b>{calendarMonth.replace("-","년 ")}월</b><button type="button" aria-label="다음 달" onClick={()=>void findCalendar(shiftMonth(calendarMonth,1),calendarProduct)}>›</button></div>
              {calendarLoading?<div className="reservation-availability-state">상품별 가격·재고를 불러오고 있습니다.</div>:calendarData&&<div className="booking-month-grid"><div className="booking-weekdays">{["일","월","화","수","목","금","토"].map(day=><b key={day}>{day}</b>)}</div><div className="booking-days">{Array.from({length:new Date(`${calendarData.dates[0]}T00:00:00Z`).getUTCDay()},(_,index)=><i key={`blank-${index}`}/>)}{calendarData.dates.map(date=>{const choices=calendarData.rows.map(row=>({row,cell:row.cells.find(cell=>cell.date===date)})).filter(item=>item.cell&&!item.cell.closed);return <button type="button" key={date} disabled={!choices.length||searching} onClick={()=>void findAvailability({...search,arrival:date,departure:addIsoDays(date,1)},calendarProduct)}><strong>{Number(date.slice(-2))}</strong>{choices.slice(0,3).map(({row,cell})=><span key={row.roomTypeId}><b>{row.code}</b><em>{formatMoney(Number(cell?.rate||0))}</em><small>{cell?.available}/{cell?.total}실</small></span>)}{!choices.length&&<small className="soldout">예약 마감</small>}{choices.length>3&&<small>외 {choices.length-3}개 타입</small>}</button>})}</div></div>}
              <p className="booking-calendar-help">날짜를 누르면 선택한 상품과 1박 일정으로 객실 목록을 엽니다. 여러 박 예약은 목록 화면에서 출발일을 조정할 수 있습니다.</p>
              <div className="wizard-actions"><button type="button" className="secondary" onClick={close}>취소</button></div>
            </div>}
            {error && <div className="report-error" role="alert">{error}</div>}
          </section>}
          {step === 1 && <section className="wizard-section"><div className="wizard-section-title"><span>2</span><div><h3>객실과 요금제를 선택하세요</h3><p>{availability?.search.nights}박 · 성인 {availability?.search.adults}명 · 아동 {availability?.search.children}명</p></div></div>
            <div className="availability-toolbar"><label><span>객실·요금제 검색</span><input aria-label="객실·요금제 검색" value={offerQuery} onChange={(event) => { setOfferQuery(event.target.value); setOfferPage(0); }} placeholder="객실 타입 또는 요금제 코드" /></label><p><b>{filteredOffers.length}</b>개 객실 타입 · 한 번에 {offersPerPage}개 표시</p></div>
            <div className="booking-product-table"><div className="booking-product-head"><span>객실종류</span><span>조식여부</span><span>기준인원</span><span>최대인원</span><span>총 금액</span><span>예약</span></div>{visibleOffers.flatMap(entry=>[...entry.plans].sort((left,right)=>left.total-right.total||left.code.localeCompare(right.code)).map((rate,index)=><button type="button" className={`booking-product-row ${planId===rate.id&&offerId===entry.roomTypeId?"selected":""}`} key={`${entry.roomTypeId}:${rate.id}`} onClick={()=>selectPlan(entry,rate)}><span data-label="객실종류"><b>{entry.code} · {entry.name}</b><small>{rate.name} · 잔여 {entry.available}실</small></span><span data-label="조식여부">{mealPlanLabel(rate.mealPlan)}</span><span data-label="기준인원">{rate.baseOccupancy}명</span><span data-label="최대인원">{Math.min(entry.capacity,rate.maxOccupancy)}명</span><span data-label="총 금액"><strong>{formatMoney(rate.total)}</strong><small>평균 {formatMoney(rate.average)} / 박</small></span><span data-label="예약"><i>{planId===rate.id&&offerId===entry.roomTypeId?"선택됨":index===0?"최저가 선택":"선택"}</i></span></button>))}{availability?.offers.length===0&&<div className="empty-state large"><b>예약가능한 객실이 없습니다.</b><p>일정이나 인원을 변경해 다시 조회해 주세요.</p></div>}{availability?.offers.length!==0&&filteredOffers.length===0&&<div className="empty-state large"><b>검색 조건에 맞는 객실·상품이 없습니다.</b><p>객실 타입명이나 판매 상품 코드를 다시 확인해 주세요.</p></div>}</div>
            {offerPageCount > 1 && <nav className="availability-pagination" aria-label="가용 객실 페이지"><button type="button" className="secondary" disabled={safePage === 0} onClick={() => setOfferPage((page) => Math.max(0, page - 1))}>← 이전 객실</button><span>{safePage + 1} / {offerPageCount}</span><button type="button" className="secondary" disabled={safePage + 1 >= offerPageCount} onClick={() => setOfferPage((page) => Math.min(offerPageCount - 1, page + 1))}>다음 객실 →</button></nav>}
            <div className="wizard-actions"><button type="button" className="secondary" onClick={() => setStep(0)}>← 일정 변경</button><button type="button" className="primary" disabled={!plan} onClick={() => setStep(2)}>고객 정보 입력 →</button></div>
          </section>}
          {step === 2 && <section className="wizard-section"><div className="wizard-section-title"><span>3</span><div><h3>고객과 예약 정보를 입력하세요</h3><p>필수 항목만 먼저 입력하고 객실 배정과 메모는 선택할 수 있습니다.</p></div></div>
            <div className="form-grid"><label><span>이름</span><input required value={guest.firstName} onChange={(event) => setGuestField("firstName", event.target.value)} /></label><label><span>성</span><input required value={guest.lastName} onChange={(event) => setGuestField("lastName", event.target.value)} /></label><label><span>이메일</span><input type="email" value={guest.email} onChange={(event) => setGuestField("email", event.target.value)} /></label><label><span>연락처</span><input inputMode="tel" value={guest.phone} onChange={(event) => setGuestField("phone", event.target.value)} /></label><label><span>예약 채널</span><select value={guest.source} onChange={(event) => setGuestField("source", event.target.value)}><option>Direct</option><option>Booking.com</option><option>Expedia</option><option>Corporate</option><option>Phone</option><option>Walk-in</option></select></label><label><span>도착 예정</span><input type="time" value={guest.eta} onChange={(event) => setGuestField("eta", event.target.value)} /></label><label><span>객실 배정</span><select value={guest.roomId} onChange={(event) => setGuestField("roomId", event.target.value)}><option value="">나중에 배정</option>{assignableRooms.map((room) => <option value={room.id} key={room.id}>{room.number} · {room.housekeeping_status === "INSPECTED" ? "점검 완료" : "청소 완료"}</option>)}</select></label><label><span>1박 적용가</span><input type="number" min="0" step="100" value={guest.nightlyRate} onChange={(event) => setGuestField("nightlyRate", event.target.value)} /><small>선택 요금의 평균가입니다. 승인된 수기 요금만 변경하세요.</small></label><label className="span-2"><span>직원 메모</span><textarea maxLength={1000} value={guest.notes} onChange={(event) => setGuestField("notes", event.target.value)} placeholder="도착 요청, 침대 구성, 내부 인수인계" /></label></div>
            <div className="wizard-actions"><button type="button" className="secondary" onClick={() => setStep(1)}>← 객실 변경</button><button type="button" className="primary" disabled={!guest.firstName.trim() || !guest.lastName.trim()} onClick={() => setStep(3)}>예약 검토 →</button></div>
          </section>}
          {step === 3 && offer && plan && <section className="wizard-section"><div className="wizard-section-title"><span>4</span><div><h3>예약 내용을 최종 확인하세요</h3><p>확정 시 모든 숙박일의 재고를 다시 검증하고 한 번에 잠급니다.</p></div></div>
            <dl className="reservation-review"><div><dt>고객</dt><dd>{guest.firstName} {guest.lastName}<small>{guest.phone || guest.email || "연락처 미입력"}</small></dd></div><div><dt>일정</dt><dd>{search.arrival} → {search.departure}<small>{availability?.search.nights}박 · 성인 {search.adults} · 아동 {search.children}</small></dd></div><div><dt>객실·요금</dt><dd>{offer.code} · {offer.name}<small>{plan.code} · {plan.name}</small></dd></div><div><dt>배정·채널</dt><dd>{assignableRooms.find((room) => room.id === guest.roomId)?.number || "미배정"}<small>{guest.source} · ETA {guest.eta}</small></dd></div><div className="total"><dt>예상 객실료</dt><dd>{formatMoney(displayedTotal)}<small>{Number(guest.nightlyRate || plan.average) === plan.average ? "일자별 요금 합계" : "수기 평균가 × 숙박일"} · 확정 후 폴리오에서 확인</small></dd></div></dl>
            <label className="wizard-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>일정, 객실 타입, 요금제, 금액과 취소 정책을 확인했습니다.</span></label>
            <div className="wizard-actions"><button type="button" className="secondary" onClick={() => setStep(2)}>← 정보 수정</button><button type="button" className="primary" disabled={!confirmed || Boolean(busy)} onClick={() => void confirmReservation()}>{busy ? "재고 재검증·확정 중…" : "예약 확정"}</button></div>
          </section>}
        </div>
        <aside className="wizard-summary"><p>예약 요약</p>{offer && plan ? <><b>{offer.code} · {offer.name}</b><span>{search.arrival} → {search.departure}</span><span>{availability?.search.nights}박 · {plan.code}</span><hr /><strong>{formatMoney(displayedTotal)}</strong><small>{plan.cancellationPolicy}</small></> : availability ? <><b>객실과 요금제를 선택하세요.</b><span>{availability.search.nights}박 · 객실 타입 {availability.offers.length}개를 찾았습니다.</span></> : <><b>일정을 먼저 조회하세요.</b><span>가용 재고와 판매 가능한 요금이 여기에 표시됩니다.</span></>}</aside>
      </div>
    </section>
  </div>;
}
