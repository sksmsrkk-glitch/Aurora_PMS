"use client";

/** Availability-first staff reservation wizard with a persistent price summary. */

import { useMemo, useState } from "react";
import { addIsoDays, formatMoney } from "../lib/format";
import { usePmsActions } from "./pms-action-context";

type Room = { id: string; number: string; room_type_id: string; front_desk_status: string; housekeeping_status: string; active: boolean };
type Plan = { id: string; code: string; name: string; cancellationPolicy: string; mealPlan: string; guaranteePolicy: string; total: number; average: number; nights: Array<{ date: string; rate: number; available: number }> };
type Offer = { roomTypeId: string; code: string; name: string; capacity: number; available: number; plans: Plan[] };
type Availability = { property: { name: string; currency: string; businessDate: string }; search: { arrival: string; departure: string; adults: number; children: number; nights: number }; offers: Offer[]; error?: string };

const steps = ["일정·인원", "객실·요금", "고객·결제", "검토·확정"];

export default function ReservationWizard({ rooms, businessDate, close }: { rooms: Room[]; businessDate: string; close: () => void }) {
  const { busy, act } = usePmsActions();
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState({ arrival: businessDate, departure: addIsoDays(businessDate, 1), adults: "2", children: "0" });
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [offerId, setOfferId] = useState("");
  const [planId, setPlanId] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [guest, setGuest] = useState({ firstName: "", lastName: "", email: "", phone: "", source: "Direct", eta: "15:00", roomId: "", notes: "", nationality: "KR", nightlyRate: "" });
  const offer = availability?.offers.find((entry) => entry.roomTypeId === offerId) || null;
  const plan = offer?.plans.find((entry) => entry.id === planId) || null;
  const displayedTotal = plan
    ? Number(guest.nightlyRate || plan.average) === plan.average
      ? plan.total
      : Number(guest.nightlyRate || 0) * Number(availability?.search.nights || 1)
    : 0;
  const assignableRooms = useMemo(() => rooms.filter((room) => room.active && room.room_type_id === offerId && room.front_desk_status === "VACANT" && ["CLEAN", "INSPECTED"].includes(room.housekeeping_status)), [offerId, rooms]);
  const setGuestField = (key: keyof typeof guest, value: string) => setGuest((current) => ({ ...current, [key]: value }));
  async function findAvailability() {
    setSearching(true); setError("");
    try {
      const params = new URLSearchParams({ view: "reservation_availability", ...search });
      const response = await fetch(`/api/pms?${params}`, { cache: "no-store" });
      const json = (await response.json()) as Availability;
      if (!response.ok) throw new Error(json.error || "가용 객실을 찾지 못했습니다.");
      setAvailability(json); setOfferId(""); setPlanId(""); setGuestField("roomId", ""); setStep(1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "가용 객실을 찾지 못했습니다."); }
    finally { setSearching(false); }
  }
  function selectPlan(nextOffer: Offer, nextPlan: Plan) {
    setOfferId(nextOffer.roomTypeId); setPlanId(nextPlan.id); setGuestField("nightlyRate", String(nextPlan.average)); setGuestField("roomId", "");
  }
  async function confirmReservation() {
    if (!offer || !plan || !confirmed) return;
    const ok = await act("create_reservation", {
      ...search, ...guest, roomTypeId: offer.roomTypeId, ratePlan: plan.code,
      nightlyRate: guest.nightlyRate || String(plan.average),
      rateOverride: String(Number(guest.nightlyRate || plan.average) !== plan.average),
    });
    if (ok) close();
  }
  return <div className="modal-backdrop reservation-wizard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-label="새 예약 만들기" className="reservation-wizard">
      <header className="wizard-header"><div><p>NEW RESERVATION</p><h2>새 예약 만들기</h2></div><button type="button" aria-label="팝업 닫기" onClick={close}>×</button></header>
      <ol className="wizard-steps">{steps.map((label, index) => <li className={index === step ? "active" : index < step ? "done" : ""} key={label}><i>{index < step ? "✓" : index + 1}</i><span>{label}</span></li>)}</ol>
      <div className="wizard-layout">
        <div className="wizard-main">
          {step === 0 && <form className="wizard-section" onSubmit={(event) => { event.preventDefault(); void findAvailability(); }}>
            <div className="wizard-section-title"><span>1</span><div><h3>언제, 몇 분이 투숙하나요?</h3><p>재고와 모든 활성 요금제를 호텔 영업일 기준으로 확인합니다.</p></div></div>
            <div className="form-grid"><label><span>도착일</span><input type="date" min={businessDate} required value={search.arrival} onChange={(event) => setSearch({ ...search, arrival: event.target.value, departure: event.target.value >= search.departure ? addIsoDays(event.target.value, 1) : search.departure })} /></label><label><span>출발일</span><input type="date" min={addIsoDays(search.arrival, 1)} required value={search.departure} onChange={(event) => setSearch({ ...search, departure: event.target.value })} /></label><label><span>성인</span><input type="number" min="1" max="20" required value={search.adults} onChange={(event) => setSearch({ ...search, adults: event.target.value })} /></label><label><span>아동</span><input type="number" min="0" max="12" required value={search.children} onChange={(event) => setSearch({ ...search, children: event.target.value })} /></label></div>
            {error && <div className="report-error" role="alert">{error}</div>}
            <div className="wizard-actions"><button type="button" className="secondary" onClick={close}>취소</button><button className="primary" disabled={searching}>{searching ? "재고·요금 확인 중…" : "가용 객실 조회"}</button></div>
          </form>}
          {step === 1 && <section className="wizard-section"><div className="wizard-section-title"><span>2</span><div><h3>객실과 요금제를 선택하세요</h3><p>{availability?.search.nights}박 · 성인 {availability?.search.adults}명 · 아동 {availability?.search.children}명</p></div></div>
            <div className="availability-offers">{availability?.offers.map((entry) => <article key={entry.roomTypeId} className={offerId === entry.roomTypeId ? "selected" : ""}><header><div><b>{entry.code}</b><h4>{entry.name}</h4><p>기준 {entry.capacity}명 · 남은 재고 최소 {entry.available}실</p></div></header><div className="offer-plans">{entry.plans.map((rate) => <button type="button" className={planId === rate.id ? "selected" : ""} key={rate.id} onClick={() => selectPlan(entry, rate)}><span><b>{rate.name}</b><small>{rate.code} · {rate.mealPlan}</small><em>{rate.cancellationPolicy}</em></span><strong>{formatMoney(rate.total)}<small>평균 {formatMoney(rate.average)} / 박</small></strong></button>)}</div></article>)}{availability?.offers.length === 0 && <div className="empty-state large"><b>판매 가능한 객실이 없습니다.</b><p>일정이나 인원을 변경해 다시 조회해 주세요.</p></div>}</div>
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
        <aside className="wizard-summary"><p>예약 요약</p>{offer && plan ? <><b>{offer.code} · {offer.name}</b><span>{search.arrival} → {search.departure}</span><span>{availability?.search.nights}박 · {plan.code}</span><hr /><strong>{formatMoney(displayedTotal)}</strong><small>{plan.cancellationPolicy}</small></> : <><b>일정을 먼저 조회하세요.</b><span>가용 재고와 판매 가능한 요금이 여기에 표시됩니다.</span></>}</aside>
      </div>
    </section>
  </div>;
}
