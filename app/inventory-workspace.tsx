"use client";

/** Keeps the core calendar and HotelStory rate-block matrix as focused subviews. */
import dynamic from "next/dynamic";
import { useState } from "react";

const loading=()=> <section className="panel module-loading"><b>요금·재고 화면을 준비하고 있습니다</b></section>;
const InventoryCalendar=dynamic(()=>import("./inventory-calendar"),{loading});
const RateBlockMatrix=dynamic(()=>import("./rate-block-matrix"),{loading});

export default function InventoryWorkspace({businessDate,canWrite}:{businessDate:string;canWrite:boolean}){
  const [view,setView]=useState<"calendar"|"rateblock">("calendar");
  return <><nav className="inventory-subnav" aria-label="재고와 요금 관리 화면"><button type="button" className={view==="calendar"?"active":""} onClick={()=>setView("calendar")}><b>판매 캘린더</b><span>호텔·홈페이지 재고와 상품 요금</span></button><button type="button" className={view==="rateblock"?"active":""} onClick={()=>setView("rateblock")}><b>블럭요금관리</b><span>객실 × 상품 × 채널 × 날짜</span></button></nav>{view==="calendar"?<InventoryCalendar businessDate={businessDate} canWrite={canWrite}/>:<RateBlockMatrix businessDate={businessDate} canWrite={canWrite}/>}</>;
}
