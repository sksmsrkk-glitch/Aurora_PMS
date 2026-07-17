"use client";

/** Date-safe search form for the public hotel landing experience. */
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

function plusDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function HotelSearchForm({ minimumArrival, initialDeparture }: { minimumArrival: string; initialDeparture: string }) {
  const router = useRouter();
  const [arrival, setArrival] = useState(minimumArrival);
  const [departure, setDeparture] = useState(initialDeparture);
  const [adults, setAdults] = useState("2");
  const [children, setChildren] = useState("0");
  const [error, setError] = useState("");
  const minimumDeparture = useMemo(() => plusDays(arrival, 1), [arrival]);
  const maximumDeparture = useMemo(() => plusDays(arrival, 30), [arrival]);

  function changeArrival(value: string) {
    const safeArrival = value < minimumArrival ? minimumArrival : value;
    setArrival(safeArrival);
    const nextMinimum = plusDays(safeArrival, 1);
    const nextMaximum = plusDays(safeArrival, 30);
    if (departure < nextMinimum || departure > nextMaximum) setDeparture(nextMinimum);
    setError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (arrival < minimumArrival || departure <= arrival || departure > maximumDeparture) {
      setError("체크아웃은 체크인 다음 날부터 최대 30박 이내로 선택해 주세요.");
      return;
    }
    router.push(`/hotel/book?${new URLSearchParams({ arrival, departure, adults, children }).toString()}`);
  }

  return <form className="hotel-search-card" onSubmit={submit} noValidate>
    <label><span>체크인</span><input type="date" name="arrival" min={minimumArrival} value={arrival} onChange={(event)=>changeArrival(event.target.value)} required/></label>
    <label><span>체크아웃</span><input type="date" name="departure" min={minimumDeparture} max={maximumDeparture} value={departure} onChange={(event)=>{setDeparture(event.target.value);setError("")}} required/></label>
    <label><span>성인</span><select name="adults" value={adults} onChange={(event)=>setAdults(event.target.value)}>{[1,2,3,4,5,6].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>어린이</span><select name="children" value={children} onChange={(event)=>setChildren(event.target.value)}>{[0,1,2,3,4].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
    <button type="submit">객실 검색</button>
    {error&&<p className="hotel-search-error" role="alert">{error}</p>}
  </form>;
}
