"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { downloadReportWorkbook, type ExportReport } from "./xlsx-export";

type CatalogItem={key:string;label:string;group:string;description:string};
type Column={key:string;label:string;type?:string};
type ReportData={catalog:readonly CatalogItem[];report:CatalogItem;title:string;description:string;generatedAt:string;filters:Filters;columns:Column[];rows:Array<Record<string,unknown>>;summary:Array<{label:string;value:number|string;format?:string}>;pagination:{page:number;pageSize:number;total:number;totalPages:number};export:{allowed:boolean;maxRows:number;masked:boolean};exportId?:string};
type Filters={q:string;from:string;to:string;status:string;source:string;roomTypeId:string};
type RoomType={id:string;code:string;name:string;active?:number|boolean};

const catalogFallback:CatalogItem[]=[
  {key:"reservations",label:"예약 상세",group:"예약",description:"예약과 고객, 객실, 채널, 잔액"},{key:"occupancy",label:"점유율 · ADR · RevPAR",group:"매출",description:"일자·타입별 핵심 영업 지표"},{key:"financials",label:"정산 · 전표",group:"정산",description:"매출·결제·환불 원장"},{key:"ar",label:"매출채권 · 미수금",group:"정산",description:"청구와 미수 잔액"},{key:"housekeeping",label:"객실 · 하우스키핑",group:"객실",description:"객실 및 청소 작업"},{key:"groups",label:"그룹 · 블록",group:"세일즈",description:"블록 할당과 픽업"},{key:"channels",label:"채널 · 인터페이스",group:"연동",description:"OTA 송수신 결과"},{key:"audit",label:"감사 로그",group:"감사",description:"사용자 변경 이력"},{key:"room_inventory",label:"객실 마스터",group:"객실",description:"타입과 객실 현황"},
];
const statusOptions:Record<string,Array<[string,string]>>={reservations:[["DUE_IN","도착 예정"],["IN_HOUSE","투숙 중"],["CHECKED_OUT","체크아웃"],["CANCELLED","취소"],["NO_SHOW","노쇼"]],financials:[["CHARGE","매출"],["PAYMENT","결제"],["REFUND","환불"],["CHARGE_REVERSAL","매출 반대전표"],["PAYMENT_REVERSAL","결제 반대전표"]],ar:[["OPEN","미수"],["PAID","완납"]],housekeeping:[["DIRTY","청소 필요"],["CLEAN","청소 완료"],["INSPECTED","점검 완료"],["OUT_OF_SERVICE","판매 중지"]],groups:[["TENTATIVE","잠정"],["DEFINITE","확정"],["CUTOFF","컷오프"],["CANCELLED","취소"]],channels:[["ACKED","성공"],["FAILED","실패"]],room_inventory:[["DIRTY","청소 필요"],["CLEAN","청소 완료"],["INSPECTED","점검 완료"],["OUT_OF_SERVICE","판매 중지"]]};
const money=(value:unknown)=>new Intl.NumberFormat("ko-KR",{style:"currency",currency:"KRW",maximumFractionDigits:0}).format(Number(value)||0);
const number=(value:unknown)=>new Intl.NumberFormat("ko-KR").format(Number(value)||0);
const cellValue=(value:unknown,type?:string)=>value==null||value===""?"—":type==="currency"?money(value):type==="percent"?`${number(value)}%`:type==="number"?number(value):String(value);

export default function ReportsCenter({businessDate,roomTypes}:{businessDate:string;roomTypes:RoomType[]}){
  const [catalog,setCatalog]=useState<readonly CatalogItem[]>(catalogFallback),[reportKey,setReportKey]=useState("reservations"),[filters,setFilters]=useState<Filters>({q:"",from:businessDate,to:businessDate,status:"",source:"",roomTypeId:""}),[applied,setApplied]=useState<Filters>({q:"",from:businessDate,to:businessDate,status:"",source:"",roomTypeId:""}),[page,setPage]=useState(1),[data,setData]=useState<ReportData|null>(null),[loading,setLoading]=useState(true),[exporting,setExporting]=useState(""),[error,setError]=useState("");
  const query=useMemo(()=>{const params=new URLSearchParams({view:"report",report:reportKey,from:applied.from,to:applied.to,page:String(page),pageSize:"25"});for(const key of ["q","status","source","roomTypeId"] as const)if(applied[key])params.set(key,applied[key]);return params.toString();},[reportKey,applied,page]);
  const load=useCallback(async(signal?:AbortSignal)=>{setLoading(true);setError("");try{const response=await fetch(`/api/pms?${query}`,{signal});const json=await response.json() as ReportData&{error?:string};if(!response.ok)throw new Error(json.error||"리포트를 조회하지 못했습니다.");setData(json);setCatalog(json.catalog);}catch(reason){if(reason instanceof DOMException&&reason.name==="AbortError")return;setError(reason instanceof Error?reason.message:"리포트를 조회하지 못했습니다.");}finally{if(!signal?.aborted)setLoading(false);}},[query]);
  // The effect synchronizes the selected server-side report query with the table.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load]);
  function changeReport(key:string){setReportKey(key);setPage(1);setFilters(current=>({...current,status:"",source:"",roomTypeId:""}));setApplied(current=>({...current,status:"",source:"",roomTypeId:""}));}
  function search(event:React.FormEvent){event.preventDefault();setPage(1);setApplied(filters);}
  async function exportRows(format:"XLSX"|"CSV"){
    setExporting(format);setError("");try{const response=await fetch("/api/pms",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({action:"export_report",format,report:reportKey,...applied})});const json=await response.json() as ReportData&{error?:string};if(!response.ok)throw new Error(json.error||"내보내기를 생성하지 못했습니다.");if(format==="XLSX")downloadReportWorkbook(json as ExportReport);else downloadCsv(json);setData(current=>current?{...current,exportId:json.exportId}:current);}catch(reason){setError(reason instanceof Error?reason.message:"내보내기를 생성하지 못했습니다.");}finally{setExporting("");}
  }
  function downloadCsv(report:ReportData){const quote=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`,rows=[report.columns.map(column=>quote(column.label)).join(","),...report.rows.map(row=>report.columns.map(column=>quote(row[column.key])).join(","))],blob=new Blob(["\ufeff",rows.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=`Aurora_${report.report.key}_${report.filters.from}.csv`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const statuses=statusOptions[reportKey]||[];
  return <section className="report-workspace">
    <aside className="report-catalog"><div className="report-catalog-head"><span>REPORT LIBRARY</span><b>{catalog.length}개 표준 리포트</b></div>{catalog.map(item=><button key={item.key} className={reportKey===item.key?"on":""} onClick={()=>changeReport(item.key)}><span>{item.group}</span><b>{item.label}</b><small>{item.description}</small></button>)}</aside>
    <div className="report-main">
      <div className="report-hero"><div><p className="eyebrow">SERVER-SIDE REPORTING · 최대 367일</p><h2>{data?.title||catalog.find(item=>item.key===reportKey)?.label}</h2><p>{data?.description||catalog.find(item=>item.key===reportKey)?.description}</p></div><div className="report-export-actions"><button className="secondary" disabled={!data?.export.allowed||!!exporting} onClick={()=>exportRows("CSV")}>{exporting==="CSV"?"생성 중…":"CSV"}</button><button className="primary" disabled={!data?.export.allowed||!!exporting} onClick={()=>exportRows("XLSX")}>{exporting==="XLSX"?"Excel 생성 중…":"↓ Excel 내보내기"}</button></div></div>
      <form className="report-filters" onSubmit={search}>
        <label className="wide"><span>키워드</span><input value={filters.q} onChange={event=>setFilters({...filters,q:event.target.value})} placeholder="예약번호, 고객, 객실, 거래 코드, 사용자…"/></label>
        <label><span>시작일</span><input type="date" value={filters.from} onChange={event=>setFilters({...filters,from:event.target.value})}/></label>
        <label><span>종료일</span><input type="date" value={filters.to} onChange={event=>setFilters({...filters,to:event.target.value})}/></label>
        <label><span>상태</span><select value={filters.status} onChange={event=>setFilters({...filters,status:event.target.value})}><option value="">전체 상태</option>{statuses.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>채널 / 사용자</span><input value={filters.source} onChange={event=>setFilters({...filters,source:event.target.value})} placeholder="예: Booking.com"/></label>
        <label><span>객실 타입</span><select value={filters.roomTypeId} onChange={event=>setFilters({...filters,roomTypeId:event.target.value})}><option value="">전체 타입</option>{roomTypes.filter(type=>type.active!==0&&type.active!==false).map(type=><option key={type.id} value={type.id}>{type.code} · {type.name}</option>)}</select></label>
        <button className="primary" type="submit">조회</button>
      </form>
      {error&&<div className="report-error" role="alert">{error}</div>}
      <div className="report-summary">{(data?.summary||[]).map(item=><article key={item.label}><span>{item.label}</span><strong>{item.format==="currency"?money(item.value):item.format==="percent"?`${number(item.value)}%`:number(item.value)}</strong></article>)}</div>
      <div className="report-table-wrap" aria-busy={loading}>
        <div className="report-table-meta"><span>{loading?"조회 중…":`${number(data?.pagination.total||0)}행 · ${data?.generatedAt?new Date(data.generatedAt).toLocaleString("ko-KR"):""}`}</span>{data?.export.masked&&<em>개인정보 마스킹됨</em>}{data?.exportId&&<em>내보내기 기록 {data.exportId.slice(0,8)}</em>}</div>
        <div className="report-scroll"><table><thead><tr>{data?.columns.map(column=><th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{!loading&&data?.rows.map((row,index)=><tr key={index}>{data.columns.map(column=><td key={column.key} className={column.type||"text"}>{cellValue(row[column.key],column.type)}</td>)}</tr>)}{!loading&&data?.rows.length===0&&<tr><td className="empty" colSpan={data.columns.length}>조건에 맞는 데이터가 없습니다.</td></tr>}</tbody></table></div>
        <div className="report-pagination"><button disabled={page<=1||loading} onClick={()=>setPage(value=>value-1)}>← 이전</button><span>{data?.pagination.page||page} / {data?.pagination.totalPages||1}</span><button disabled={page>=(data?.pagination.totalPages||1)||loading} onClick={()=>setPage(value=>value+1)}>다음 →</button></div>
      </div>
    </div>
  </section>;
}
