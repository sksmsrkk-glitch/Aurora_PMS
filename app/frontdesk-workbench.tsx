"use client";

/** Server-filtered front desk queue built around today's executable hotel work. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "../lib/format";

export type FrontdeskReservation = {
  id: string; confirmation_no: string; first_name: string; last_name: string;
  vip_level: string; room_number: string | null; room_id: string | null;
  room_type_id: string; room_type_code: string; room_type_name: string;
  arrival_date: string; departure_date: string; status: string; adults: number;
  children: number; source: string; rate_plan: string; nightly_rate: number;
  eta: string | null; notes: string; balance: number; version: number;
  external_reservation_id?: string | null; email?: string | null; phone?: string | null;
};
type QueueKey = "TODAY" | "ALL" | "DUE_IN" | "IN_HOUSE" | "DUE_OUT" | "UNASSIGNED" | "BALANCE";
type Filters = { q: string; status: string; dateField: "arrival" | "departure"; from: string; to: string; source: string; roomTypeId: string; assignment: string; balance: string; sort: string };
type Payload = {
  query: Filters & { queue: QueueKey; page: number; pageSize: number };
  rows: FrontdeskReservation[];
  queues: { total?: number; due_in?: number; in_house?: number; due_out?: number; unassigned?: number; balance_due?: number };
  roomTypes: Array<{ id: string; code: string; name: string }>;
  sources: Array<{ source: string; count: number }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  error?: string;
};
type SavedView = { id: string; name: string; queue: QueueKey; filters: Filters };

const labels: Record<string, string> = {
  DUE_IN: "도착 예정", IN_HOUSE: "투숙 중", CHECKED_OUT: "체크아웃",
  CANCELLED: "취소", NO_SHOW: "노쇼",
};
const emptyFilters = (): Filters => ({ q: "", status: "", dateField: "arrival", from: "", to: "", source: "", roomTypeId: "", assignment: "ALL", balance: "ALL", sort: "eta" });
const storageKey = (propertyId: string) => `talos:frontdesk-views:${propertyId}`;

function readViews(propertyId: string): SavedView[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(propertyId)) || "[]");
    return Array.isArray(value) ? value.slice(0, 8) : [];
  } catch { return []; }
}

export default function FrontdeskWorkbench({ propertyId, businessDate, onOpen }: { propertyId: string; businessDate: string; onOpen: (reservation: FrontdeskReservation) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focus = searchParams.get("focus") || "";
  const [queue, setQueue] = useState<QueueKey>("TODAY");
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => readViews(propertyId));
  const [viewName, setViewName] = useState("");
  const query = useMemo(() => {
    const params = new URLSearchParams({ view: "frontdesk", queue, page: String(page), pageSize: "20", ...applied });
    if (focus) params.set("focus", focus);
    for (const [key, value] of [...params.entries()]) if (!value) params.delete(key);
    return params.toString();
  }, [applied, focus, page, queue]);
  const result = useQuery({
    queryKey: ["pms", "frontdesk", query],
    queryFn: async () => {
      const response = await fetch(`/api/pms?${query}`, { cache: "no-store" });
      const json = (await response.json()) as Payload;
      if (!response.ok) throw new Error(json.error || "프런트 업무를 불러오지 못했습니다.");
      return json;
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (!focus || !result.data?.rows[0]) return;
    onOpen(result.data.rows[0]);
    router.replace("/frontdesk", { scroll: false });
  }, [focus, onOpen, result.data, router]);
  const data = result.data;
  const queueItems: Array<[QueueKey, string, number]> = [
    ["TODAY", "오늘 업무", Number(data?.queues.due_in || 0) + Number(data?.queues.in_house || 0)],
    ["DUE_IN", "도착 예정", Number(data?.queues.due_in || 0)],
    ["IN_HOUSE", "재실", Number(data?.queues.in_house || 0)],
    ["DUE_OUT", "오늘 출발", Number(data?.queues.due_out || 0)],
    ["UNASSIGNED", "미배정", Number(data?.queues.unassigned || 0)],
    ["BALANCE", "잔액 있음", Number(data?.queues.balance_due || 0)],
    ["ALL", "전체 예약", Number(data?.queues.total || 0)],
  ];
  const activeFilters = [
    applied.q && `검색 ${applied.q}`, applied.from && `${applied.dateField === "arrival" ? "도착" : "출발"} ${applied.from}~${applied.to || ""}`,
    applied.status && labels[applied.status], applied.source && `채널 ${applied.source}`,
    applied.roomTypeId && `객실 타입`, applied.assignment === "UNASSIGNED" && "미배정",
    applied.assignment === "ASSIGNED" && "배정 완료", applied.balance === "DUE" && "잔액 있음",
    applied.balance === "CLEAR" && "잔액 없음",
  ].filter(Boolean) as string[];
  const saveView = () => {
    const name = viewName.trim().slice(0, 30);
    if (!name) return;
    const next = [{ id: crypto.randomUUID(), name, queue, filters: applied }, ...savedViews].slice(0, 8);
    setSavedViews(next); window.localStorage.setItem(storageKey(propertyId), JSON.stringify(next)); setViewName("");
  };
  const removeView = (id: string) => {
    const next = savedViews.filter((view) => view.id !== id);
    setSavedViews(next); window.localStorage.setItem(storageKey(propertyId), JSON.stringify(next));
  };
  const applyView = (view: SavedView) => { setQueue(view.queue); setDraft(view.filters); setApplied(view.filters); setPage(1); };
  return <section className="panel full frontdesk-workbench">
    <div className="panel-title frontdesk-title"><div><p className="eyebrow">TODAY WORKBENCH · {businessDate}</p><h2>예약·체크인 업무</h2><p>오늘 처리할 예약을 먼저 보고, 전체 예약은 검색과 필터로 찾습니다.</p></div><button type="button" className="secondary" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>필터 {activeFilters.length ? activeFilters.length : ""} {advanced ? "접기" : "열기"}</button></div>
    <div className="frontdesk-queues" role="tablist" aria-label="프런트 업무 큐">{queueItems.map(([key, label, count]) => <button type="button" role="tab" aria-selected={queue === key} className={queue === key ? "on" : ""} key={key} onClick={() => { setQueue(key); setPage(1); }}><span>{label}</span><b>{count}</b></button>)}</div>
    <form className={`frontdesk-filter-panel ${advanced ? "open" : ""}`} onSubmit={(event) => { event.preventDefault(); setApplied(draft); setPage(1); }}>
      <label className="wide"><span>예약 검색</span><input value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} placeholder="고객·예약번호·전화·채널 예약번호·객실" /></label>
      <label><span>날짜 기준</span><select value={draft.dateField} onChange={(event) => setDraft({ ...draft, dateField: event.target.value as Filters["dateField"] })}><option value="arrival">도착일</option><option value="departure">출발일</option></select></label>
      <label><span>시작일</span><input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label><span>종료일</span><input type="date" min={draft.from} value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label><span>예약 상태</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">전체 상태</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label><span>채널</span><select value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })}><option value="">전체 채널</option>{data?.sources.map((source) => <option value={source.source} key={source.source}>{source.source} · {source.count}</option>)}</select></label>
      <label><span>객실 타입</span><select value={draft.roomTypeId} onChange={(event) => setDraft({ ...draft, roomTypeId: event.target.value })}><option value="">전체 타입</option>{data?.roomTypes.map((type) => <option value={type.id} key={type.id}>{type.code} · {type.name}</option>)}</select></label>
      <label><span>객실 배정</span><select value={draft.assignment} onChange={(event) => setDraft({ ...draft, assignment: event.target.value })}><option value="ALL">전체</option><option value="UNASSIGNED">미배정</option><option value="ASSIGNED">배정 완료</option></select></label>
      <label><span>잔액</span><select value={draft.balance} onChange={(event) => setDraft({ ...draft, balance: event.target.value })}><option value="ALL">전체</option><option value="DUE">잔액 있음</option><option value="CLEAR">잔액 없음</option></select></label>
      <label><span>정렬</span><select value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value })}><option value="eta">업무 우선·ETA</option><option value="arrival">도착일</option><option value="departure">출발일</option><option value="updated">최근 변경</option></select></label>
      <div className="frontdesk-filter-actions"><button type="button" className="secondary" onClick={() => { const empty = emptyFilters(); setDraft(empty); setApplied(empty); setPage(1); }}>초기화</button><button type="submit" className="primary">조회</button></div>
      <div className="saved-view-create"><input aria-label="현재 조건 이름" value={viewName} maxLength={30} onChange={(event) => setViewName(event.target.value)} placeholder="예: 오늘 미배정 OTA" /><button type="button" className="secondary" disabled={!viewName.trim()} onClick={saveView}>현재 조건 저장</button></div>
    </form>
    {(savedViews.length > 0 || activeFilters.length > 0) && <div className="frontdesk-view-strip">{savedViews.map((view) => <span className="saved-view" key={view.id}><button type="button" onClick={() => applyView(view)}>☆ {view.name}</button><button type="button" aria-label={`${view.name} 저장 보기 삭제`} onClick={() => removeView(view.id)}>×</button></span>)}{activeFilters.map((filter) => <em key={filter}>{filter}</em>)}</div>}
    {result.error && <div className="report-error" role="alert">{result.error instanceof Error ? result.error.message : "프런트 업무를 불러오지 못했습니다."}</div>}
    <div className="frontdesk-result-meta"><b>{result.isFetching ? "예약을 조회하고 있습니다…" : `${data?.pagination.total.toLocaleString("ko-KR") || 0}건`}</b><span>한 페이지 20건 · 필터는 이 기기에 안전하게 저장됩니다.</span></div>
    <div className="reservation-table frontdesk-server-table" aria-busy={result.isFetching}>
      <div className="table-head"><span>고객 / 예약</span><span>숙박</span><span>객실</span><span>채널</span><span>잔액</span><span>상태</span></div>
      {data?.rows.map((reservation) => <button type="button" key={reservation.id} className="table-row" onClick={() => onOpen(reservation)}>
        <span className="guest"><i>{reservation.first_name[0]}{reservation.last_name[0]}</i><span><b>{reservation.first_name} {reservation.last_name}</b><small>{reservation.confirmation_no}{reservation.external_reservation_id ? ` · ${reservation.external_reservation_id}` : ""}</small></span>{reservation.vip_level !== "NONE" && <em>{reservation.vip_level}</em>}</span>
        <span data-label="숙박"><b>{reservation.arrival_date.slice(5)} → {reservation.departure_date.slice(5)}</b><small>{reservation.eta ? `ETA ${reservation.eta.slice(0, 5)}` : "시간 미정"}</small></span>
        <span data-label="객실"><b>{reservation.room_number || "미배정"}</b><small>{reservation.room_type_code} · {reservation.room_type_name}</small></span>
        <span data-label="채널"><b>{reservation.source}</b><small>{reservation.rate_plan}</small></span>
        <span data-label="잔액" className={Number(reservation.balance) !== 0 ? "due" : ""}>{formatMoney(Number(reservation.balance))}</span>
        <span data-label="상태"><i className={`status ${reservation.status === "IN_HOUSE" ? "stay" : reservation.status === "DUE_IN" ? "ready" : ""}`}>{labels[reservation.status] || reservation.status}</i></span>
      </button>)}
      {!result.isFetching && data?.rows.length === 0 && <div className="empty-state large"><b>조건에 맞는 예약이 없습니다.</b><p>다른 업무 큐를 선택하거나 필터를 초기화해 보세요.</p></div>}
    </div>
    <div className="frontdesk-pagination"><button type="button" disabled={page <= 1 || result.isFetching} onClick={() => setPage((value) => value - 1)}>← 이전</button><span>{data?.pagination.page || page} / {data?.pagination.totalPages || 1}</span><button type="button" disabled={page >= (data?.pagination.totalPages || 1) || result.isFetching} onClick={() => setPage((value) => value + 1)}>다음 →</button></div>
  </section>;
}
