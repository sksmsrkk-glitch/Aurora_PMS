"use client";

/** Accessible, bounded physical-room assignment board for front-desk operators. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { addIsoDays } from "../lib/format";
import type { FrontdeskReservation } from "./frontdesk-workbench";
import { usePmsActions } from "./pms-action-context";
import { normalizedRoomMoveMode, occupiedRoomDates } from "./room-board-coverage";

type BoardRoom={id:string;number:string;floor:number;room_type_id:string;room_type_code:string;room_type_name:string;front_desk_status:string;housekeeping_status:string;version:number};
type BoardSpan={id:string;roomId:string;startDate:string;endDate:string;dates:string[];reservation:FrontdeskReservation};
type BoardPayload={from:string;to:string;days:number;dates:string[];businessDate:string;rooms:BoardRoom[];spans:BoardSpan[];unassigned:FrontdeskReservation[];summary:{arrivals:number;inHouse:number;departures:number;unassigned:number;sellable:number};error?:string};
type DragItem={reservation:FrontdeskReservation;span:BoardSpan|null};
type AssignmentDialog={item:DragItem;room:BoardRoom;dropDate:string};
type CreatePrefill={arrivalDate:string;roomTypeId:string;roomId:string};

const statusLabel:Record<string,string>={CLEAN:"청소 완료",INSPECTED:"점검 완료",DIRTY:"청소 필요",OUT_OF_SERVICE:"판매 중지",VACANT:"공실",OCCUPIED:"재실",DUE_IN:"도착 예정",IN_HOUSE:"투숙 중"};
const viewWindows=[7,14,30] as const;
const boardHeaderHeight=58;
const validFrom=(value:string,businessDate:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(value))return businessDate;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf())&&parsed.toISOString().slice(0,10)===value?value:businessDate;
};
const dayLabel=(date:string)=>new Intl.DateTimeFormat("ko-KR",{month:"numeric",day:"numeric",weekday:"short",timeZone:"UTC"}).format(new Date(`${date}T00:00:00Z`));

function BoardReservationCard({span,canWrite,pending,onOpen,onDrag,onChoose,onUnassign}:{span:BoardSpan;canWrite:boolean;pending:boolean;onOpen:(row:FrontdeskReservation)=>void;onDrag:(item:DragItem|null)=>void;onChoose:(item:DragItem)=>void;onUnassign:(row:FrontdeskReservation)=>void}){
  const row=span.reservation;
  return <article className={`room-board-stay ${row.status.toLowerCase()} ${pending?"pending":""}`} aria-busy={pending}>
    <button type="button" className="room-board-stay-main" disabled={pending} draggable={canWrite&&!pending} onDragStart={event=>{event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",row.id);onDrag({reservation:row,span});}} onDragEnd={()=>onDrag(null)} onClick={()=>onOpen(row)}>
      <b>{row.first_name} {row.last_name}</b><span>{row.confirmation_no} · {statusLabel[row.status]||row.status}</span>
    </button>
    {canWrite&&<div className="room-board-stay-actions"><button type="button" disabled={pending} aria-label={`${row.first_name} ${row.last_name} 객실 선택`} onClick={()=>onChoose({reservation:row,span})}>객실 선택</button>{row.status!=="IN_HOUSE"&&<button type="button" disabled={pending} aria-label={`${row.first_name} ${row.last_name} 배정 해제`} onClick={()=>onUnassign(row)}>해제</button>}</div>}
  </article>;
}

export default function FrontdeskRoomBoard({businessDate,canWrite,onOpen,onCreate}:{businessDate:string;canWrite:boolean;onOpen:(row:FrontdeskReservation)=>void;onCreate:(prefill:CreatePrefill)=>void}){
  const router=useRouter(),searchParams=useSearchParams(),{busy,act}=usePmsActions();
  const requestedDays=Number(searchParams.get("days")),days=(viewWindows as readonly number[]).includes(requestedDays)?requestedDays:7;
  const from=validFrom(searchParams.get("from")||"",businessDate),to=addIsoDays(from,days);
  const [dragged,setDragged]=useState<DragItem|null>(null),[dialog,setDialog]=useState<AssignmentDialog|null>(null),[roomPicker,setRoomPicker]=useState<DragItem|null>(null),[pendingReservationId,setPendingReservationId]=useState<string|null>(null);
  const query=useQuery({queryKey:["pms","frontdesk","room-board",from,to],queryFn:async()=>{const params=new URLSearchParams({view:"room_board",from,to});const response=await fetch(`/api/pms?${params}`,{cache:"no-store"}),json=await response.json() as BoardPayload;if(!response.ok)throw new Error(json.error||"객실 배정 보드를 불러오지 못했습니다.");return json;},staleTime:5_000,placeholderData:keepPreviousData});
  const data=query.data;
  const boardScrollRef=useRef<HTMLDivElement>(null);
  // TanStack Virtual intentionally exposes mutable measurement callbacks; the
  // component consumes them directly and never passes them into memoized UI.
  // eslint-disable-next-line react-hooks/incompatible-library
  const roomVirtualizer=useVirtualizer({count:data?.rooms.length||0,getScrollElement:()=>boardScrollRef.current,estimateSize:()=>82,overscan:8,scrollMargin:boardHeaderHeight});
  const spansByRoom=useMemo(()=>{const map=new Map<string,BoardSpan[]>();for(const span of data?.spans||[])map.set(span.roomId,[...(map.get(span.roomId)||[]),span]);return map;},[data?.spans]);
  const navigate=(nextFrom:string,nextDays=days)=>{const params=new URLSearchParams({view:"board",from:nextFrom,days:String(nextDays)});router.replace(`/frontdesk?${params}`,{scroll:false});};
  const beginDrop=(room:BoardRoom,date:string)=>{if(dragged)setDialog({item:dragged,room,dropDate:date});};
  const runAssignment=async(row:FrontdeskReservation,action:string,payload:Record<string,string>)=>{if(pendingReservationId)return false;setPendingReservationId(row.id);try{return await act(action,payload);}finally{setPendingReservationId(null);}};
  const unassign=async(row:FrontdeskReservation)=>{if(!window.confirm(`${row.first_name} ${row.last_name} 예약의 물리 객실 배정을 해제할까요?\n객실 타입 재고는 유지됩니다.`))return;await runAssignment(row,"unassign_reservation_room",{reservationId:row.id,expectedVersion:String(row.version)});};
  return <section className="panel full frontdesk-room-board" aria-busy={query.isFetching}>
    <div className="room-board-title"><div><p className="eyebrow">PHYSICAL ROOM ASSIGNMENT</p><h2>일자별 룸 배정 보드</h2><p>타입 재고와 분리된 실제 객실 박을 배정합니다. 드래그가 어려우면 각 예약의 ‘객실 선택’을 이용하세요.</p></div><div className="room-board-window" role="group" aria-label="보드 조회 기간">{viewWindows.map(value=><button type="button" className={days===value?"on":""} aria-pressed={days===value} key={value} onClick={()=>navigate(from,value)}>{value}일</button>)}</div></div>
    <div className="room-board-summary" aria-label="프런트 요약"><span><small>오늘 도착</small><b>{data?.summary.arrivals??0}</b></span><span><small>투숙 중</small><b>{data?.summary.inHouse??0}</b></span><span><small>오늘 출발</small><b>{data?.summary.departures??0}</b></span><span className={(data?.summary.unassigned??0)>0?"warn":""}><small>미배정</small><b>{data?.summary.unassigned??0}</b></span><span><small>판매 가능 객실</small><b>{data?.summary.sellable??0}</b></span></div>
    <div className="room-board-toolbar"><button type="button" className="secondary" onClick={()=>navigate(addIsoDays(from,-days))}>← 이전 {days}일</button><label><span>시작일</span><input type="date" value={from} onChange={event=>navigate(event.target.value)}/></label><button type="button" className="secondary" onClick={()=>navigate(businessDate)}>오늘</button><b>{from} → {addIsoDays(to,-1)}</b><button type="button" className="secondary" onClick={()=>navigate(addIsoDays(from,days))}>다음 {days}일 →</button></div>
    {query.error&&<div className="report-error" role="alert">{query.error instanceof Error?query.error.message:"객실 배정 보드를 불러오지 못했습니다."}</div>}
    {query.isLoading&&<div className="reservation-detail-state"><b>객실과 숙박 배정을 불러오고 있습니다</b><p>최대 31일의 물리 객실 박을 한 번에 확인하고 있어요.</p></div>}
    {data&&<>
      <aside className="room-board-unassigned" aria-label="미배정 예약"><header><div><b>미배정 예약</b><span>{data.unassigned.length}건 · 객실로 끌어 배정</span></div></header><div>{data.unassigned.map(row=>{const pending=row.id===pendingReservationId;return <article className={pending?"pending":""} aria-busy={pending} key={row.id} draggable={canWrite&&!pending} onDragStart={event=>{event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",row.id);setDragged({reservation:row,span:null});}} onDragEnd={()=>setDragged(null)}><button type="button" disabled={pending} onClick={()=>onOpen(row)}><b>{row.first_name} {row.last_name}</b><span>{row.arrival_date.slice(5)} → {row.departure_date.slice(5)} · {row.room_type_code}</span><small>{row.confirmation_no}</small></button>{canWrite&&<button type="button" className="secondary" disabled={pending} onClick={()=>setRoomPicker({reservation:row,span:null})}>객실 선택</button>}</article>})}{!data.unassigned.length&&<p>조회 기간에 미배정 예약이 없습니다.</p>}</div></aside>
      <div ref={boardScrollRef} className="room-board-scroll" role="region" aria-label={`${from}부터 ${days}일 객실 배정표`} tabIndex={0}>
        <div className="room-board-grid" style={{["--board-days" as string]:String(days)}}>
          <div className="room-board-header"><div className="room-board-room-head">객실 · 층 · 타입</div>{data.dates.map(date=><div className={date===businessDate?"today":""} key={date}><b>{dayLabel(date)}</b><small>{date}</small></div>)}</div>
          <div className="room-board-virtual-body" style={{height:`${roomVirtualizer.getTotalSize()}px`}}>
            {roomVirtualizer.getVirtualItems().map(virtualRow=>{const room=data.rooms[virtualRow.index],spans=spansByRoom.get(room.id)||[],occupiedDates=occupiedRoomDates(spans);return <div ref={roomVirtualizer.measureElement} data-index={virtualRow.index} className={`room-board-row ${room.housekeeping_status.toLowerCase()}`} style={{transform:`translateY(${virtualRow.start-boardHeaderHeight}px)`}} key={room.id}>
              <div className="room-board-room"><b>{room.number}</b><span>{room.floor}층 · {room.room_type_code}</span><small><i/>{statusLabel[room.front_desk_status]||room.front_desk_status} · {statusLabel[room.housekeeping_status]||room.housekeeping_status}</small></div>
              {data.dates.map((date,index)=>{const occupied=occupiedDates.has(date);return <button type="button" className={`room-board-cell ${date===businessDate?"today":""}`} style={{gridColumn:index+2}} key={date} disabled={!canWrite||occupied||room.housekeeping_status==="OUT_OF_SERVICE"} aria-label={`${room.number}호 ${date} ${occupied?"배정됨":room.housekeeping_status==="OUT_OF_SERVICE"?"판매 중지":"빈 셀"}`} onDragOver={event=>{if(canWrite&&!occupied&&room.housekeeping_status!=="OUT_OF_SERVICE")event.preventDefault();}} onDrop={event=>{event.preventDefault();if(!occupied)beginDrop(room,date);}} onClick={()=>onCreate({arrivalDate:date,roomTypeId:room.room_type_id,roomId:room.id})}><span>＋</span></button>})}
              {spans.map(span=>{const start=Math.max(0,data.dates.indexOf(span.startDate));const visible=span.dates.filter(date=>data.dates.includes(date));if(!visible.length)return null;return <div className="room-board-span-slot" style={{gridColumn:`${start+2} / span ${visible.length}`}} key={span.id}><BoardReservationCard span={{...span,dates:visible}} canWrite={canWrite} pending={span.reservation.id===pendingReservationId} onOpen={onOpen} onDrag={setDragged} onChoose={setRoomPicker} onUnassign={row=>void unassign(row)}/></div>;})}
            </div>})}
          </div>
        </div>
      </div>
    </>}
    {roomPicker&&data&&<RoomPicker item={roomPicker} rooms={data.rooms} close={()=>setRoomPicker(null)} choose={(room,date)=>{setRoomPicker(null);setDialog({item:roomPicker,room,dropDate:date});}}/>}
    {dialog&&<AssignmentDecision key={`${dialog.item.reservation.id}:${dialog.room.id}:${dialog.dropDate}`} dialog={dialog} busy={busy} close={()=>setDialog(null)} submit={async(requestedMode)=>{const row=dialog.item.reservation,mode=normalizedRoomMoveMode(requestedMode,row.arrival_date,dialog.dropDate),payload={reservationId:row.id,roomId:dialog.room.id,expectedVersion:String(row.version),warningOverride:"true"};const ok=await runAssignment(row,mode==="FROM_DATE"?"move_reservation_room":"assign_reservation_room",mode==="FROM_DATE"?{...payload,moveDate:dialog.dropDate,reason:"ROOM_BOARD"}:payload);if(ok)setDialog(null);}}/>}
  </section>;
}

function RoomPicker({item,rooms,close,choose}:{item:DragItem;rooms:BoardRoom[];close:()=>void;choose:(room:BoardRoom,date:string)=>void}){
  const [roomId,setRoomId]=useState(""),[date,setDate]=useState(item.span?.startDate||item.reservation.arrival_date),room=rooms.find(row=>row.id===roomId);
  return <div className="modal-backdrop"><form className="cashier-modal room-board-dialog" onSubmit={event=>{event.preventDefault();if(room)choose(room,date);}}><div className="drawer-head"><div><p>{item.reservation.confirmation_no}</p><h2>이 예약 → 객실 선택</h2></div><button type="button" onClick={close}>×</button></div><div className="stack-form"><label><span>목적 객실</span><select required value={roomId} onChange={event=>setRoomId(event.target.value)}><option value="">객실 선택</option>{rooms.filter(row=>row.housekeeping_status!=="OUT_OF_SERVICE").map(row=><option value={row.id} key={row.id}>{row.number} · {row.room_type_code} · {statusLabel[row.housekeeping_status]}</option>)}</select></label>{item.span&&<label><span>이 날짜부터 이동</span><input type="date" min={item.reservation.arrival_date} max={addIsoDays(item.reservation.departure_date,-1)} value={date} onChange={event=>setDate(event.target.value)}/></label>}</div><div className="modal-actions"><button type="button" className="secondary" onClick={close}>닫기</button><button className="primary" disabled={!room}>다음</button></div></form></div>;
}

function AssignmentDecision({dialog,busy,close,submit}:{dialog:AssignmentDialog;busy:string;close:()=>void;submit:(mode:"FULL"|"FROM_DATE")=>Promise<void>}){
  const {reservation,span}=dialog.item,canSplit=Boolean(span&&dialog.dropDate>reservation.arrival_date),warnings=[dialog.room.room_type_id!==reservation.room_type_id?`예약 타입 ${reservation.room_type_code}과 객실 타입 ${dialog.room.room_type_code}이 다릅니다.`:"",dialog.room.housekeeping_status==="DIRTY"?"청소가 필요한 객실입니다.":""].filter(Boolean),[ack,setAck]=useState(false),[mode,setMode]=useState<"FULL"|"FROM_DATE">(canSplit?"FROM_DATE":"FULL");
  return <div className="modal-backdrop"><form className="cashier-modal room-board-dialog" onSubmit={event=>{event.preventDefault();void submit(mode);}}><div className="drawer-head"><div><p>{reservation.confirmation_no} · V{reservation.version}</p><h2>{dialog.room.number}호로 배정</h2></div><button type="button" onClick={close}>×</button></div><dl className="room-board-decision-facts"><div><dt>고객</dt><dd>{reservation.first_name} {reservation.last_name}</dd></div><div><dt>숙박</dt><dd>{reservation.arrival_date} → {reservation.departure_date}</dd></div><div><dt>목적 객실</dt><dd>{dialog.room.number} · {dialog.room.room_type_code}</dd></div></dl>{span&&<fieldset className="room-board-move-mode"><legend>적용 범위</legend><label><input type="radio" name="mode" checked={mode==="FULL"} onChange={()=>setMode("FULL")}/><span><b>전체 숙박일 변경</b><small>도착일부터 출발 전날까지 모두 {dialog.room.number}호</small></span></label>{canSplit?<label><input type="radio" name="mode" checked={mode==="FROM_DATE"} onChange={()=>setMode("FROM_DATE")}/><span><b>{dialog.dropDate}부터 이동</b><small>이전 날짜는 기존 객실을 유지하고 이후만 이동</small></span></label>:<p className="room-board-full-note">도착일 이동은 전체 숙박일 변경으로 처리됩니다.</p>}</fieldset>}{warnings.length>0&&<div className="room-board-warning" role="alert"><b>확인이 필요한 운영 경고</b>{warnings.map(item=><p key={item}>• {item}</p>)}<label><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/><span>경고를 확인했으며 배정 이력에 사유가 기록되는 것에 동의합니다.</span></label></div>}<div className="modal-actions"><button type="button" className="secondary" onClick={close}>취소</button><button className="primary" disabled={Boolean(busy)||Boolean(warnings.length&&!ack)}>{busy?"동시 배정 검증 중…":"배정 확정"}</button></div></form></div>;
}
