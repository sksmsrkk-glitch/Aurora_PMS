"use client";

/** Interactive direct-booking flow with race-safe availability searches. */

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Offer = { roomTypeId:string;code:string;name:string;description:string;imageUrl:string|null;amenities:string[];capacity:number;available:number;averageNightlyRate:number;total:number;currency:string;nights:{date:string;rate:number;available:number}[] };
type Availability = { property:{name:string;currency:string;businessDate:string};search:{arrival:string;departure:string;adults:number;children:number;nights:number};offers:Offer[] };
type Search = { arrival:string;departure:string;adults:string;children:string };

function dateAfter(days:number) { const date=new Date(Date.now()+days*86_400_000),parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date),value=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${value.year}-${value.month}-${value.day}`; }
function plusDays(value:string,days:number){const date=new Date(`${value}T00:00:00.000Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
function money(value:number,currency="KRW") { return new Intl.NumberFormat("ko-KR",{style:"currency",currency,maximumFractionDigits:0}).format(value); }
function roomClass(code:string) { return code==="DLX"?"art-one":code==="TWN"?"art-two":"art-three"; }

function initialSearch(params:ReturnType<typeof useSearchParams>):Search {
  const minimum=dateAfter(1),requestedArrival=params.get("arrival")||"";
  const arrival=/^\d{4}-\d{2}-\d{2}$/u.test(requestedArrival)&&requestedArrival>=minimum?requestedArrival:minimum;
  const requestedDeparture=params.get("departure")||"",minimumDeparture=plusDays(arrival,1),maximumDeparture=plusDays(arrival,30);
  const departure=requestedDeparture>=minimumDeparture&&requestedDeparture<=maximumDeparture?requestedDeparture:minimumDeparture;
  const adults=["1","2","3","4","5","6"].includes(params.get("adults")||"")?String(params.get("adults")):"2";
  const children=["0","1","2","3","4"].includes(params.get("children")||"")?String(params.get("children")):"0";
  return {arrival,departure,adults,children};
}

export default function BookingClient() {
  const params=useSearchParams();
  const [search,setSearch]=useState<Search>(()=>initialSearch(params));
  const [availability,setAvailability]=useState<Availability|null>(null);
  const [selected,setSelected]=useState<Offer|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [confirmation,setConfirmation]=useState<{confirmation:string;arrival:string;departure:string;total?:number;currency?:string}|null>(null);
  const [cancelOpen,setCancelOpen]=useState(false);
  const [cancelMessage,setCancelMessage]=useState("");
  const requestKey=useRef("");
  const searchRequest=useRef<{sequence:number;controller:AbortController|null}>({sequence:0,controller:null});

  async function runSearch(next:Search) {
    if(next.arrival<dateAfter(1)||next.departure<=next.arrival||next.departure>plusDays(next.arrival,30)){setError("체크아웃은 체크인 다음 날부터 최대 30박 이내로 선택해 주세요.");return;}
    searchRequest.current.controller?.abort();
    const controller=new AbortController(),sequence=searchRequest.current.sequence+1;
    searchRequest.current={sequence,controller};
    setLoading(true);setError("");setSelected(null);setConfirmation(null);requestKey.current="";
    try {
      const query=new URLSearchParams(next);
      const response=await fetch(`/api/booking/availability?${query}`,{cache:"no-store",signal:controller.signal});
      const payload=await response.json() as Availability&{error?:string};
      if(!response.ok)throw new Error(payload.error||"객실을 검색하지 못했습니다.");
      if(sequence!==searchRequest.current.sequence)return;
      setAvailability(payload);
      window.history.replaceState(null,"",`/hotel/book?${query}`);
    } catch(reason) { if(reason instanceof DOMException&&reason.name==="AbortError")return;setAvailability(null);setError(reason instanceof Error?reason.message:"객실을 검색하지 못했습니다."); }
    finally { if(sequence===searchRequest.current.sequence)setLoading(false); }
  }

  useEffect(()=>{ const timer=window.setTimeout(()=>void runSearch(search),0);return()=>window.clearTimeout(timer); /* The initial URL is the booking search source of truth. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  function submitSearch(event:FormEvent<HTMLFormElement>) { event.preventDefault();void runSearch(search); }

  async function reserve(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!selected||!availability)return;
    setLoading(true);setError("");
    const form=new FormData(event.currentTarget);
    if(!requestKey.current)requestKey.current=`web:${crypto.randomUUID()}`;
    try {
      const response=await fetch("/api/booking/reservations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":requestKey.current},body:JSON.stringify({
        arrival:availability.search.arrival,departure:availability.search.departure,adults:availability.search.adults,children:availability.search.children,roomTypeId:selected.roomTypeId,
        firstName:form.get("firstName"),lastName:form.get("lastName"),email:form.get("email"),phone:form.get("phone"),specialRequests:form.get("specialRequests"),
      })});
      const payload=await response.json() as {error?:string;confirmation:string;arrival:string;departure:string;total?:number;currency?:string};
      if(!response.ok)throw new Error(payload.error||"예약을 확정하지 못했습니다.");
      setConfirmation(payload);setSelected(null);window.scrollTo({top:0,behavior:"smooth"});
    } catch(reason) { setError(reason instanceof Error?reason.message:"예약을 확정하지 못했습니다."); }
    finally { setLoading(false); }
  }

  async function cancel(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setLoading(true);setCancelMessage("");
    const form=new FormData(event.currentTarget);
    try {
      const response=await fetch("/api/booking/reservations",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({confirmation:form.get("confirmation"),email:form.get("email"),lastName:form.get("lastName")})});
      const payload=await response.json() as {error?:string;confirmation?:string};
      if(!response.ok)throw new Error(payload.error||"예약을 취소하지 못했습니다.");
      setCancelMessage(`${payload.confirmation} 예약이 취소되었습니다.`);
    } catch(reason) { setCancelMessage(reason instanceof Error?reason.message:"예약을 취소하지 못했습니다."); }
    finally { setLoading(false); }
  }

  return <main className="booking-page">
    <header className="booking-header"><Link className="hotel-brand" href="/hotel"><Image src="/brand/aurora-mark-192.png" alt="" width={38} height={38} priority/><span><b>AURORA</b><small>SEOUL</small></span></Link><div><span>01 객실 선택</span><i/><span>02 정보 입력</span><i/><span>03 예약 완료</span></div><Link href="/hotel">홈으로</Link></header>
    <section className="booking-wrap">
      {confirmation ? <section className="booking-confirmed" aria-live="polite"><div className="confirm-check">✓</div><p>RESERVATION CONFIRMED</p><h1>예약이 완료되었습니다</h1><span>예약번호를 저장해 주세요. 예약 확인과 취소에 필요합니다.</span><strong>{confirmation.confirmation}</strong><dl><div><dt>체크인</dt><dd>{confirmation.arrival}</dd></div><div><dt>체크아웃</dt><dd>{confirmation.departure}</dd></div>{confirmation.total!=null&&<div><dt>총 금액</dt><dd>{money(confirmation.total,confirmation.currency)}</dd></div>}</dl><p className="payment-note">결제는 호텔 체크인 시 진행됩니다. 등록한 이메일로 예약 안내가 발송됩니다.</p><div><button onClick={()=>void runSearch(search)}>다른 객실 보기</button><Link href="/hotel">호텔 홈</Link></div></section> : <>
        <div className="booking-title"><div><p>BOOK YOUR STAY</p><h1>객실 예약</h1><span>PMS 실시간 재고와 요금이 바로 반영됩니다.</span></div><button type="button" className="cancel-link" onClick={()=>setCancelOpen(value=>!value)}>기존 예약 취소</button></div>
        {cancelOpen&&<form className="cancel-box" onSubmit={cancel}><div><b>웹 예약 취소</b><span>도착일 전날까지 온라인 취소가 가능합니다.</span></div><input name="confirmation" placeholder="예약번호" required/><input name="lastName" placeholder="성 (Last name)" required/><input name="email" type="email" placeholder="예약 이메일" required/><button disabled={loading}>예약 취소</button>{cancelMessage&&<p role="status">{cancelMessage}</p>}</form>}
        <form className="booking-search" onSubmit={submitSearch}><label><span>체크인</span><input type="date" min={dateAfter(1)} value={search.arrival} onChange={event=>{const arrival=event.target.value,departure=search.departure<=arrival||search.departure>plusDays(arrival,30)?plusDays(arrival,1):search.departure;setSearch({...search,arrival,departure})}} required/></label><label><span>체크아웃</span><input type="date" min={plusDays(search.arrival,1)} max={plusDays(search.arrival,30)} value={search.departure} onChange={event=>setSearch({...search,departure:event.target.value})} required/></label><label><span>성인</span><select value={search.adults} onChange={event=>setSearch({...search,adults:event.target.value})}>{[1,2,3,4,5,6].map(value=><option key={value}>{value}</option>)}</select></label><label><span>어린이</span><select value={search.children} onChange={event=>setSearch({...search,children:event.target.value})}>{[0,1,2,3,4].map(value=><option key={value}>{value}</option>)}</select></label><button type="submit" disabled={loading}>{loading?"조회 중":"다시 검색"}</button></form>
        {error&&<p className="booking-error" role="alert">{error}</p>}
        {availability&&<div className="booking-summary"><b>{availability.search.arrival} — {availability.search.departure}</b><span>{availability.search.nights}박 · 성인 {availability.search.adults}명{availability.search.children>0?` · 어린이 ${availability.search.children}명`:""} · {availability.offers.length}개 객실 타입</span></div>}
        <section className="offer-list" aria-busy={loading}>{loading&&!availability?<div className="booking-loading">PMS에서 실시간 재고를 확인하고 있습니다.</div>:availability?.offers.length===0?<div className="no-offers"><b>현재 판매 가능한 객실이 없습니다</b><span>날짜나 투숙 인원을 변경해 다시 검색해 주세요.</span></div>:availability?.offers.map(offer=><article className="offer-card" key={offer.roomTypeId}><i className={`offer-art room-art ${offer.imageUrl?"cms-room-image":roomClass(offer.code)}`} style={offer.imageUrl?{backgroundImage:`url(${JSON.stringify(offer.imageUrl)})`}:undefined}><small>{offer.code}</small></i><div className="offer-copy"><small>{offer.code} · 최대 {offer.capacity}인</small><h2>{offer.name}</h2><p>{offer.description}</p><ul>{(offer.amenities.length?offer.amenities.slice(0,3):["무료 Wi-Fi","프리미엄 침구","현장 결제"]).map(item=><li key={item}>{item}</li>)}</ul>{offer.available<=3&&<em>해당 일정 {offer.available}실 남음</em>}</div><div className="offer-rate"><span>{availability.search.nights}박 총액</span><strong>{money(offer.total,offer.currency)}</strong><small>1박 평균 {money(offer.averageNightlyRate,offer.currency)}</small><button type="button" onClick={()=>{setSelected(offer);setError("");requestKey.current="";}}>선택</button></div></article>)}</section>
      </>}
    </section>
    {selected&&availability&&<div className="booking-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setSelected(null)}}><aside className="booking-drawer" role="dialog" aria-modal="true" aria-labelledby="guest-title"><div className="booking-drawer-head"><div><small>GUEST DETAILS</small><h2 id="guest-title">예약자 정보를 입력해 주세요</h2></div><button type="button" aria-label="닫기" onClick={()=>setSelected(null)}>×</button></div><div className="drawer-offer"><i className={`room-art ${selected.imageUrl?"cms-room-image":roomClass(selected.code)}`} style={selected.imageUrl?{backgroundImage:`url(${JSON.stringify(selected.imageUrl)})`}:undefined}/><div><b>{selected.name}</b><span>{availability.search.arrival} — {availability.search.departure} · {availability.search.nights}박</span></div><strong>{money(selected.total,selected.currency)}</strong></div><form className="guest-form" onSubmit={reserve}><div className="guest-name"><label><span>이름</span><input name="firstName" autoComplete="given-name" maxLength={80} required/></label><label><span>성</span><input name="lastName" autoComplete="family-name" maxLength={80} required/></label></div><label><span>이메일</span><input name="email" type="email" autoComplete="email" maxLength={254} placeholder="예약 확인 메일을 보내드립니다" required/></label><label><span>연락처</span><input name="phone" type="tel" autoComplete="tel" maxLength={24} placeholder="010-0000-0000" required/></label><label><span>요청 사항 <small>선택</small></span><textarea name="specialRequests" maxLength={1000} rows={3} placeholder="호텔에 전달할 요청 사항을 입력해 주세요."/></label><label className="privacy-check"><input type="checkbox" required/><span>예약 처리 및 고객 응대를 위한 개인정보 수집·이용에 동의합니다.</span></label><div className="booking-total"><span><b>총 결제 예정 금액</b><small>호텔 현장 결제</small></span><strong>{money(selected.total,selected.currency)}</strong></div>{error&&<p className="booking-error" role="alert">{error}</p>}<button type="submit" className="booking-submit" disabled={loading}>{loading?"안전하게 예약 중":"예약 확정"}</button></form></aside></div>}
  </main>;
}
