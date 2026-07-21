"use client";

/** Multi-channel rate and inventory calendar, including direct-web controls. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { addIsoDays, formatMoney } from "../lib/format";
import { ListSearch } from "./list-search";
import { usePmsActions } from "./pms-action-context";
import { boundedCalendarWindow, inclusiveDays, matchingDayCount } from "./inventory-window";

type ChannelRate = {
  mapping_id: string;
  sell_rate: number;
  net_rate: number | null;
};
type RatePlanRate = {
  rate_plan_id: string;
  code: string;
  rate_plan_name: string;
  sell_rate: number;
  closed: boolean;
  min_stay: number;
};
type Cell = {
  stayDate: string;
  sellLimit: number;
  reserved: number;
  available: number;
  closed: boolean;
  websiteClosed: boolean;
  minStay: number;
  cta: boolean;
  ctd: boolean;
  price: number;
  ratePlanRates: RatePlanRate[];
  channelRates: ChannelRate[];
};
type RoomType = {
  id: string;
  code: string;
  name: string;
  base_rate: number;
  physical: number;
  cells: Cell[];
};
type Mapping = {
  id: string;
  connection_id: string;
  room_type_id: string;
  provider: string;
  connection_name: string;
  rate_plan: string;
  external_rate_plan_id: string;
};
type Contract = {
  id: string;
  connection_id: string;
  contract_type: "COMMISSION" | "NET_RATE";
  commission_percent: number;
  connection_name: string;
  provider: string;
};
type RatePlan = {
  id: string;
  code: string;
  name: string;
  description: string;
  currency: string;
  market_segment: string;
  meal_plan: string;
  cancellation_policy: string;
  guarantee_policy: string;
  pricing_model: "FIXED" | "OFFSET" | "PERCENT";
  adjustment: number;
  min_stay: number;
  max_stay: number;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  version: number;
};
type InventoryData = {
  range: { from: string; to: string; days: number };
  dates: string[];
  types: RoomType[];
  mappings: Mapping[];
  contracts: Contract[];
  ratePlans: RatePlan[];
};
type Editor = { mode: "bulk"; type?: RoomType; cell?: Cell } | null;
type DetailMode = "CORE" | "RATE_PLAN" | "CHANNEL";

const money = formatMoney;
const addDays = addIsoDays;
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];

export default function RevenueInventoryCalendar({
  businessDate,
  canWrite,
}: {
  businessDate: string;
  canWrite: boolean;
}) {
  const { act } = usePmsActions();
  // The full selected period is retained for bulk writes, while `cursor` and
  // `windowDays` bound each read/render to 14 or 30 days. A year-long selection
  // therefore never produces a 365-column DOM or a giant read response.
  const [from, setFrom] = useState(businessDate),
    [to, setTo] = useState(addDays(businessDate, 29)),
    [applied, setApplied] = useState({
      from: businessDate,
      to: addDays(businessDate, 29),
    }),
    [cursor, setCursor] = useState(businessDate),
    [windowDays, setWindowDays] = useState<14 | 30>(14),
    [detailMode, setDetailMode] = useState<DetailMode>("CORE"),
    [data, setData] = useState<InventoryData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [typeQuery, setTypeQuery] = useState(""),
    [typePage, setTypePage] = useState(1),
    [editor, setEditor] = useState<Editor>(null),
    [rateEditor,setRateEditor]=useState<RatePlan|"new"|null>(null);
  const visibleWindow = useMemo(() => boundedCalendarWindow(cursor, applied.to, windowDays), [applied.to, cursor, windowDays]);
  const visibleTo = visibleWindow.to;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ view: "inventory", from: cursor, to: visibleTo }),
        response = await fetch(`/api/pms?${params}`, { cache: "no-store" }),
        json = (await response.json()) as InventoryData & { error?: string };
      if (!response.ok)
        throw new Error(json.error || "재고 캘린더를 불러오지 못했습니다.");
      setData(json);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "재고 캘린더를 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [cursor, visibleTo]);
  // The effect synchronizes the selected server-side calendar range.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  function preset(days: number) {
    const end = addDays(businessDate, days - 1);
    setFrom(businessDate);
    setTo(end);
    setApplied({ from: businessDate, to: end });
    setCursor(businessDate);
    setTypePage(1);
  }
  const gridTemplate = useMemo(
    () => `190px repeat(${data?.dates.length || 1}, 132px)`,
    [data?.dates.length],
  );
  // Filtering only changes rendered room-type rows; date columns and server totals
  // remain untouched, so a keyword can never alter the inventory calculation.
  const filteredTypes = useMemo(() => {
    const keyword = typeQuery.trim().toLocaleLowerCase("ko-KR");
    return data?.types.filter((type) => !keyword || `${type.code} ${type.name}`.toLocaleLowerCase("ko-KR").includes(keyword)) || [];
  }, [data, typeQuery]);
  const typePageSize = 10;
  const typePages = Math.max(1, Math.ceil(filteredTypes.length / typePageSize));
  const visibleTypes = filteredTypes.slice((typePage - 1) * typePageSize, typePage * typePageSize);
  const selectedDays = inclusiveDays(applied.from, applied.to);
  const bulkData = data ? { ...data, range: { from: applied.from, to: applied.to, days: selectedDays } } : null;
  return (
    <>
      <section className="panel inventory-workspace">
        <div className="inventory-toolbar">
          <div>
            <p className="eyebrow">CALENDAR RATE & INVENTORY</p>
            <h2>자유 기간 판매 캘린더</h2>
            <p>
              호텔 판매가·가용 재고·홈페이지 노출과 채널 판매가/입금가를 같은 날짜 축에서 관리합니다.
            </p>
          </div>
          <div
            className="inventory-presets"
            role="group"
            aria-label="조회 기간"
          >
            <button onClick={() => preset(30)}>30일</button>
            <button onClick={() => preset(90)}>90일</button>
            <button onClick={() => preset(180)}>180일</button>
            <button onClick={() => preset(365)}>1년</button>
          </div>
        </div>
        {data && (
          <RatePlanBoard
            plans={data.ratePlans}
            canWrite={canWrite}
            edit={setRateEditor}
          />
        )}
        <form
          className="inventory-range"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ from, to });
            setCursor(from);
            setTypePage(1);
          }}
        >
          <label>
            <span>시작일</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <span className="range-arrow">→</span>
          <label>
            <span>종료일</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary">조회</button>
          {canWrite && (
            <button
              type="button"
              className="primary"
              onClick={() => setEditor({ mode: "bulk" })}
            >
              ＋ 기간 벌크 설정
            </button>
          )}
          {data&&<ListSearch value={typeQuery} onChange={(value)=>{setTypeQuery(value);setTypePage(1)}} label="재고 객실 타입 검색" placeholder="객실 코드·타입명" count={filteredTypes.length} className="inventory-type-search"/>}
          <em>
            {data
              ? `${selectedDays.toLocaleString()}일 선택 · 현재 ${data.range.from}~${data.range.to}`
              : "조회 중"}
          </em>
        </form>
        {data&&<div className="inventory-view-controls"><div className="inventory-window-nav"><button type="button" className="secondary" disabled={cursor<=applied.from} onClick={()=>setCursor((value)=>{const previous=addDays(value,-windowDays);return previous<applied.from?applied.from:previous})}>← 이전</button><b>{data.range.from} ~ {data.range.to}</b><button type="button" className="secondary" disabled={visibleTo>=applied.to} onClick={()=>setCursor(addDays(cursor,windowDays))}>다음 →</button></div><div className="inventory-segmented" role="group" aria-label="캘린더 표시 범위"><button type="button" className={windowDays===14?"on":""} onClick={()=>{setWindowDays(14);setCursor(applied.from)}}>14일</button><button type="button" className={windowDays===30?"on":""} onClick={()=>{setWindowDays(30);setCursor(applied.from)}}>30일</button></div><div className="inventory-segmented" role="group" aria-label="셀 상세 정보"><button type="button" className={detailMode==="CORE"?"on":""} onClick={()=>setDetailMode("CORE")}>재고</button><button type="button" className={detailMode==="RATE_PLAN"?"on":""} onClick={()=>setDetailMode("RATE_PLAN")}>요금제</button><button type="button" className={detailMode==="CHANNEL"?"on":""} onClick={()=>setDetailMode("CHANNEL")}>채널</button></div></div>}
        {error && (
          <div className="report-error" role="alert">
            {error}
          </div>
        )}
        {loading && !data ? (
          <div className="inventory-loading">
            판매 캘린더를 계산하고 있어요…
          </div>
        ) : (
          data && (
            <div
              className="inventory-scroll advanced-calendar"
              aria-busy={loading}
            >
              <div
                className="inventory-grid"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="inventory-corner">
                  <b>객실 타입</b>
                  <span>재고 · 호텔가 · 채널가</span>
                </div>
                {data.dates.map((date) => (
                  <div
                    className={`inventory-date ${[0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? "weekend" : ""}`}
                    key={date}
                  >
                    <b>{date.slice(5).replace("-", ".")}</b>
                    <span>
                      {weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]}
                    </span>
                  </div>
                ))}
                {visibleTypes.map((type) => (
                  <InventoryRow
                    key={type.id}
                    type={type}
                    mappings={data.mappings}
                    contracts={data.contracts}
                    detailMode={detailMode}
                    canWrite={canWrite}
                    edit={(cell) => setEditor({ mode: "bulk", type, cell })}
                  />
                ))}
                {visibleTypes.length===0&&<div className="inventory-filter-empty">검색 조건에 맞는 객실 타입이 없습니다.</div>}
              </div>
            </div>
          )
        )}
        {filteredTypes.length>typePageSize&&<div className="inventory-type-pagination"><button type="button" className="secondary" disabled={typePage<=1} onClick={()=>setTypePage((page)=>Math.max(1,page-1))}>이전 객실 타입</button><span>{typePage}/{typePages} 페이지 · {filteredTypes.length}개 타입</span><button type="button" className="secondary" disabled={typePage>=typePages} onClick={()=>setTypePage((page)=>Math.min(typePages,page+1))}>다음 객실 타입</button></div>}
        <div className="inventory-footnote">
          <span>
            <i className="available" />
            판매 가능
          </span>
          <span>
            <i className="low" />
            마감 임박
          </span>
          <span>
            <i className="closed" />
            판매 마감
          </span>
          <span>
            <i className="web-closed" />
            홈페이지 숨김
          </span>
          <p>
            최대 730일까지 조회·변경할 수 있으며, 한 번에 5,000개 타입·일자 셀을
            벌크 저장합니다.
          </p>
        </div>
      </section>
      {editor && bulkData && (
        <BulkInventoryModal
          data={bulkData}
          editor={editor}
          close={() => setEditor(null)}
          submit={async (payload) => {
            if (await act("bulk_update_inventory_controls", payload)) {
              setEditor(null);
              await load();
            }
          }}
        />
      )}
      {rateEditor && data && (
        <RatePlanModal
          plan={rateEditor === "new" ? null : rateEditor}
          close={() => setRateEditor(null)}
          submit={async (payload) => {
            if (await act("upsert_rate_plan", payload)) {
              setRateEditor(null);
              await load();
            }
          }}
        />
      )}
    </>
  );
}

function RatePlanBoard({plans,canWrite,edit}:{plans:RatePlan[];canWrite:boolean;edit:(plan:RatePlan|"new")=>void}){
  return <section className="rate-plan-board"><div className="rate-plan-board-head"><div><b>요금제 포트폴리오</b><span>판매 조건·유효 기간·객실별 일자 요금</span></div>{canWrite&&<button type="button" className="secondary" onClick={()=>edit("new")}>＋ 요금제</button>}</div><div className="rate-plan-cards">{plans.map(plan=><button type="button" key={plan.id} disabled={!canWrite} className={plan.active?"":"inactive"} onClick={()=>edit(plan)}><span><b>{plan.code}</b><i>{plan.active?"판매 중":"중지"}</i></span><strong>{plan.name}</strong><small>{plan.pricing_model} · {plan.min_stay}~{plan.max_stay}박 · {plan.currency}</small></button>)}</div></section>
}

function RatePlanModal({plan,close,submit}:{plan:RatePlan|null;close:()=>void;submit:(payload:Record<string,string>)=>Promise<void>}){
  const [busy,setBusy]=useState(false),[form,setForm]=useState({code:plan?.code||"",name:plan?.name||"",description:plan?.description||"",currency:plan?.currency||"KRW",marketSegment:plan?.market_segment||"TRANSIENT",mealPlan:plan?.meal_plan||"ROOM_ONLY",cancellationPolicy:plan?.cancellation_policy||"FLEXIBLE",guaranteePolicy:plan?.guarantee_policy||"CARD_GUARANTEE",pricingModel:plan?.pricing_model||"FIXED",adjustment:String(plan?.adjustment||0),minStay:String(plan?.min_stay||1),maxStay:String(plan?.max_stay||30),validFrom:plan?.valid_from||"",validTo:plan?.valid_to||"",active:String(plan?.active!==false)}),set=(key:string,value:string)=>setForm(current=>({...current,[key]:value}));
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close()}}><form role="dialog" aria-modal="true" aria-label="요금제 편집" className="booking-modal rate-plan-modal" onSubmit={async event=>{event.preventDefault();setBusy(true);try{await submit({...form,...(plan?{ratePlanId:plan.id,version:String(plan.version)}:{})})}finally{setBusy(false)}}}><div className="drawer-head"><div><p>RATE PLAN MASTER</p><h2>{plan?`${plan.code} 요금제 편집`:"새 요금제 만들기"}</h2></div><button type="button" onClick={close}>×</button></div><p className="form-intro">예약·공식 홈페이지·채널 매핑이 참조하는 표준 요금제입니다. 사용된 코드는 변경할 수 없습니다.</p><div className="form-grid"><label><span>요금제 코드</span><input required disabled={Boolean(plan)} maxLength={24} value={form.code} onChange={e=>set("code",e.target.value.toUpperCase())}/></label><label><span>요금제 이름</span><input required maxLength={100} value={form.name} onChange={e=>set("name",e.target.value)}/></label><label><span>통화</span><input required maxLength={3} value={form.currency} onChange={e=>set("currency",e.target.value.toUpperCase())}/></label><label><span>가격 모델</span><select value={form.pricingModel} onChange={e=>set("pricingModel",e.target.value)}><option value="FIXED">고정가</option><option value="OFFSET">기준가 증감액</option><option value="PERCENT">기준가 증감률</option></select></label><label><span>기준 조정값</span><input type="number" value={form.adjustment} onChange={e=>set("adjustment",e.target.value)}/></label><label><span>시장 세그먼트</span><input value={form.marketSegment} onChange={e=>set("marketSegment",e.target.value)}/></label><label><span>최소 숙박</span><input type="number" min="1" max="365" value={form.minStay} onChange={e=>set("minStay",e.target.value)}/></label><label><span>최대 숙박</span><input type="number" min={form.minStay} max="365" value={form.maxStay} onChange={e=>set("maxStay",e.target.value)}/></label><label><span>판매 시작일</span><input type="date" value={form.validFrom} onChange={e=>set("validFrom",e.target.value)}/></label><label><span>판매 종료일</span><input type="date" min={form.validFrom} value={form.validTo} onChange={e=>set("validTo",e.target.value)}/></label><label><span>식사 조건</span><input value={form.mealPlan} onChange={e=>set("mealPlan",e.target.value)}/></label><label><span>취소 정책</span><input value={form.cancellationPolicy} onChange={e=>set("cancellationPolicy",e.target.value)}/></label><label className="span-2"><span>설명</span><textarea maxLength={1000} value={form.description} onChange={e=>set("description",e.target.value)}/></label><label className="toggle"><input type="checkbox" checked={form.active==="true"} onChange={e=>set("active",String(e.target.checked))}/><span>판매 활성화</span></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={close}>닫기</button><button className="primary" disabled={busy}>{busy?"저장 중…":"요금제 저장"}</button></div></form></div>
}

function InventoryRow({
  type,
  mappings,
  contracts,
  detailMode,
  canWrite,
  edit,
}: {
  type: RoomType;
  mappings: Mapping[];
  contracts: Contract[];
  detailMode: DetailMode;
  canWrite: boolean;
  edit: (cell: Cell) => void;
}) {
  // Commercial meaning is contract-dependent: commission channels show the
  // percentage deducted from sell rate, while net-rate channels show the distinct
  // hotel deposit amount. Neither value is inferred from the public website rate.
  const mapped = mappings.filter((mapping) => mapping.room_type_id === type.id),
    contractMap = new Map(
      contracts.map((contract) => [contract.connection_id, contract]),
    );
  return (
    <>
      <div className="inventory-type">
        <b>{type.code}</b>
        <span>{type.name}</span>
        <small>판매 가능 {type.physical}실</small>
      </div>
      {type.cells.map((cell) => (
        <button
          type="button"
          key={cell.stayDate}
          disabled={!canWrite}
          className={`inventory-cell rich ${cell.closed ? "closed" : cell.available <= 1 ? "low" : ""} ${cell.websiteClosed ? "website-hidden" : ""}`}
          onClick={() => edit(cell)}
        >
          <span>{cell.closed ? "마감" : `${cell.available}실`}</span>
          <small>
            확정 {cell.reserved} · 한도 {cell.sellLimit}
          </small>
          <strong>{money(cell.price)}</strong>
          {cell.websiteClosed&&<mark>WEB OFF</mark>}
          {detailMode==="RATE_PLAN"&&cell.ratePlanRates.slice(0,2).map(plan=><em className="plan-rate" key={plan.rate_plan_id}><b>{plan.code}</b> {plan.closed?"마감":money(Number(plan.sell_rate))}<small> / MLOS {plan.min_stay}</small></em>)}
          {detailMode==="CHANNEL"&&mapped.slice(0, 2).map((mapping) => {
            const rate = cell.channelRates.find(
                (item) => item.mapping_id === mapping.id,
              ),
              contract = contractMap.get(mapping.connection_id);
            return (
              <em key={mapping.id}>
                <b>{mapping.provider.replace("_COM", "")}</b>{" "}
                {rate ? money(Number(rate.sell_rate)) : "—"}
                {contract?.contract_type === "NET_RATE" && (
                  <small>
                    {" "}
                    / 입금{" "}
                    {rate?.net_rate == null
                      ? "—"
                      : money(Number(rate.net_rate))}
                  </small>
                )}
                {contract?.contract_type === "COMMISSION" && (
                  <small> / {Number(contract.commission_percent)}%</small>
                )}
              </em>
            );
          })}
          {detailMode==="CORE"&&(cell.minStay > 1 || cell.cta || cell.ctd) && (
            <i>
              {cell.minStay > 1 ? `MLOS ${cell.minStay}` : ""}
              {cell.cta ? " CTA" : ""}
              {cell.ctd ? " CTD" : ""}
            </i>
          )}
        </button>
      ))}
    </>
  );
}

function BulkInventoryModal({
  data,
  editor,
  close,
  submit,
}: {
  data: InventoryData;
  editor: NonNullable<Editor>;
  close: () => void;
  submit: (payload: Record<string, string>) => Promise<void>;
}) {
  // Empty bulk fields intentionally mean “keep each cell's existing value”. A
  // single-cell edit pre-fills every field, while multi-cell edits stay sparse to
  // avoid overwriting unrelated controls across a long date range.
  const single = Boolean(editor.type && editor.cell),
    initialTypeIds = editor.type
      ? [editor.type.id]
      : data.types.map((type) => type.id),
    [typeIds, setTypeIds] = useState(initialTypeIds),
    [days, setDays] = useState([0, 1, 2, 3, 4, 5, 6]),
    [busy, setBusy] = useState(false),
    [channelEnabled, setChannelEnabled] = useState(
      Boolean(editor.cell?.channelRates.length),
    ),
    [mappingId, setMappingId] = useState(
      editor.cell?.channelRates[0]?.mapping_id || "",
    );
  const mappings = data.mappings.filter((mapping) =>
      typeIds.includes(mapping.room_type_id),
    ),
    mapping = data.mappings.find((item) => item.id === mappingId),
    contract = data.contracts.find(
      (item) => item.connection_id === mapping?.connection_id,
    ),
    rate = editor.cell?.channelRates.find(
      (item) => item.mapping_id === mappingId,
    ),selectedPlanRate=editor.cell?.ratePlanRates.find(item=>item.code==="WEB-DIRECT")||editor.cell?.ratePlanRates[0];
  const [form, setForm] = useState({
      from: editor.cell?.stayDate || data.range.from,
      to: editor.cell?.stayDate || data.range.to,
      sellLimit: editor.cell ? String(editor.cell.sellLimit) : "",
      priceOverride: editor.cell ? String(editor.cell.price) : "",
      ratePlanId: selectedPlanRate?.rate_plan_id || "",
      ratePlanSellRate: selectedPlanRate ? String(selectedPlanRate.sell_rate) : "",
      minStay: editor.cell ? String(editor.cell.minStay) : "1",
      closed: editor.cell ? String(editor.cell.closed) : "false",
      cta: editor.cell ? String(editor.cell.cta) : "false",
      ctd: editor.cell ? String(editor.cell.ctd) : "false",
      websiteClosed: editor.cell ? String(editor.cell.websiteClosed) : "",
      channelSellRate: rate ? String(rate.sell_rate) : "",
      channelNetRate: rate?.net_rate == null ? "" : String(rate.net_rate),
    }),
    set = (key: string, value: string) =>
      setForm((current) => ({ ...current, [key]: value }));
  const affectedCells = matchingDayCount(form.from, form.to, days) * typeIds.length;
  const approvalSignature = `${form.from}:${form.to}:${[...days].sort().join(",")}:${[...typeIds].sort().join(",")}`;
  const [approvedSignature, setApprovedSignature] = useState("");
  const needsExplicitApproval = !single && affectedCells > 50;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="요금 및 재고 편집"
        className="booking-modal inventory-bulk-modal"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            // The API revalidates the 730-day/5,000-cell bounds, physical capacity,
            // committed rooms, channel mapping, and contract before writing.
            await submit({
              ...form,
              roomTypeIds: JSON.stringify(typeIds),
              weekdays: JSON.stringify(days),
              mappingId: channelEnabled ? mappingId : "",
              channelSellRate: channelEnabled ? form.channelSellRate : "",
              channelNetRate: channelEnabled ? form.channelNetRate : "",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="drawer-head">
          <div>
            <p>
              {single
                ? `${editor.cell?.stayDate} · ${editor.type?.code}`
                : "BULK CALENDAR CONTROL"}
            </p>
            <h2>{single ? "일자별 판매 설정" : "기간 벌크 요금·재고"}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        <div className="bulk-scroll-body">
          <p className="form-intro">
            빈 판매 한도·호텔 판매가는 기존 값을 유지합니다. 채널 요금은 객실
            타입과 연결된 매핑에만 적용됩니다.
          </p>
          <div className="bulk-date-grid">
            <label>
              <span>시작일</span>
              <input
                type="date"
                required
                disabled={single}
                value={form.from}
                onChange={(event) => set("from", event.target.value)}
              />
            </label>
            <label>
              <span>요금제 캘린더 <small>선택 적용</small></span>
              <select value={form.ratePlanId} onChange={(event)=>{const id=event.target.value,setRate=editor.cell?.ratePlanRates.find(item=>item.rate_plan_id===id);set("ratePlanId",id);set("ratePlanSellRate",setRate?String(setRate.sell_rate):"")}}>
                <option value="">요금제 변경 안 함</option>
                {data.ratePlans.filter(plan=>plan.active).map(plan=><option value={plan.id} key={plan.id}>{plan.code} · {plan.name}</option>)}
              </select>
            </label>
            <label>
              <span>요금제 판매가 <small>빈칸=호텔가</small></span>
              <input type="number" min="0" step="100" disabled={!form.ratePlanId} value={form.ratePlanSellRate} onChange={event=>set("ratePlanSellRate",event.target.value)}/>
            </label>
            <label>
              <span>종료일</span>
              <input
                type="date"
                required
                disabled={single}
                value={form.to}
                min={form.from}
                onChange={(event) => set("to", event.target.value)}
              />
            </label>
          </div>
          {!single && (
            <>
              <fieldset className="bulk-selector">
                <legend>객실 타입</legend>
                {data.types.map((type) => (
                  <label key={type.id}>
                    <input
                      type="checkbox"
                      checked={typeIds.includes(type.id)}
                      onChange={(event) => {
                        setTypeIds((current) =>
                          event.target.checked
                            ? [...current, type.id]
                            : current.filter((id) => id !== type.id),
                        );
                        if (!event.target.checked && mapping?.room_type_id === type.id) {
                          setMappingId("");
                          setChannelEnabled(false);
                        }
                      }}
                    />
                    <span>
                      {type.code} · {type.name}
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="weekday-selector">
                <legend>적용 요일</legend>
                {weekdays.map((label, index) => (
                  <label
                    key={label}
                    className={days.includes(index) ? "on" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={days.includes(index)}
                      onChange={(event) =>
                        setDays((current) =>
                          event.target.checked
                            ? [...current, index]
                            : current.filter((day) => day !== index),
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <div className="form-grid">
            <label>
              <span>
                판매 한도 <small>빈칸=유지</small>
              </span>
              <input
                type="number"
                min="0"
                value={form.sellLimit}
                onChange={(event) => set("sellLimit", event.target.value)}
              />
            </label>
            <label>
              <span>
                호텔 판매가 <small>빈칸=유지</small>
              </span>
              <input
                type="number"
                min="0"
                step="100"
                value={form.priceOverride}
                onChange={(event) => set("priceOverride", event.target.value)}
              />
            </label>
            <label>
              <span>최소 숙박</span>
              <input
                type="number"
                min="1"
                max="30"
                value={form.minStay}
                onChange={(event) => set("minStay", event.target.value)}
              />
            </label>
            <label className="toggle-field">
              <span>판매 마감</span>
              <input
                type="checkbox"
                checked={form.closed === "true"}
                onChange={(event) =>
                  set("closed", String(event.target.checked))
                }
              />
            </label>
            <label>
              <span>공식 홈페이지 노출</span>
              <select value={form.websiteClosed} onChange={(event)=>set("websiteClosed",event.target.value)}>
                {!single&&<option value="">기존 설정 유지</option>}
                <option value="false">노출 · 직접 예약 허용</option>
                <option value="true">숨김 · 직접 예약 중지</option>
              </select>
            </label>
            <label className="toggle-field">
              <span>도착 제한 CTA</span>
              <input
                type="checkbox"
                checked={form.cta === "true"}
                onChange={(event) => set("cta", String(event.target.checked))}
              />
            </label>
            <label className="toggle-field">
              <span>출발 제한 CTD</span>
              <input
                type="checkbox"
                checked={form.ctd === "true"}
                onChange={(event) => set("ctd", String(event.target.checked))}
              />
            </label>
          </div>
          {!single&&<div className={`bulk-impact ${needsExplicitApproval?"warning":""}`}><span><b>{affectedCells.toLocaleString("ko-KR")}개 셀 변경 예정</b><small>{typeIds.length}개 객실 타입 · 선택 요일만 원자적으로 반영됩니다.</small></span>{needsExplicitApproval?<label><input type="checkbox" checked={approvedSignature===approvalSignature} onChange={(event)=>setApprovedSignature(event.target.checked?approvalSignature:"")}/><span>영향 범위를 확인했으며 적용합니다.</span></label>:<i aria-hidden="true">✓</i>}</div>}
          <label className="channel-rate-toggle">
            <span>
              <b>채널별 판매가·입금가</b>
              <small>
                계약 조건에 따라 수수료 또는 호텔 입금가를 계산합니다.
              </small>
            </span>
            <input
              type="checkbox"
              checked={channelEnabled}
              onChange={(event) => setChannelEnabled(event.target.checked)}
            />
          </label>
          {channelEnabled && (
            <div className="channel-rate-fields">
              <label>
                <span>채널 · 요금 매핑</span>
                <select
                  required
                  value={mappingId}
                  onChange={(event) => setMappingId(event.target.value)}
                >
                  <option value="">선택</option>
                  {mappings.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.provider} · {item.rate_plan} ·{" "}
                      {item.external_rate_plan_id}
                    </option>
                  ))}
                </select>
              </label>
              {mapping && contract ? (
                <>
                  <div className="contract-inline">
                    <b>
                      {contract.contract_type === "COMMISSION"
                        ? `판매가 수수료 ${Number(contract.commission_percent)}%`
                        : "호텔 입금가 계약"}
                    </b>
                    <span>{contract.connection_name}</span>
                  </div>
                  <label>
                    <span>채널 판매가</span>
                    <input
                      required
                      type="number"
                      min="0"
                      step="100"
                      value={form.channelSellRate}
                      onChange={(event) =>
                        set("channelSellRate", event.target.value)
                      }
                    />
                  </label>
                  {contract.contract_type === "NET_RATE" && (
                    <label>
                      <span>호텔 입금가</span>
                      <input
                        required
                        type="number"
                        min="0"
                        max={form.channelSellRate || undefined}
                        step="100"
                        value={form.channelNetRate}
                        onChange={(event) =>
                          set("channelNetRate", event.target.value)
                        }
                      />
                    </label>
                  )}
                </>
              ) : (
                mapping && (
                  <div className="contract-warning">
                    채널 허브에서 이 연결의 계약 조건을 먼저 설정해 주세요.
                  </div>
                )
              )}
            </div>
          )}
        </div>
        <div className="modal-actions sticky">
          <button type="button" className="secondary" onClick={close}>
            닫기
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !typeIds.length ||
              !days.length ||
              (needsExplicitApproval && approvedSignature !== approvalSignature) ||
              (channelEnabled && !contract)
            }
          >
            {busy
              ? "검증·저장 중…"
              : single
                ? "판매 설정 저장"
                : "기간 전체 적용"}
          </button>
        </div>
      </form>
    </div>
  );
}
