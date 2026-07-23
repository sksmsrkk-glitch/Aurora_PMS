"use client";

/** Filterable operational reports with CSV/XLSX export controls. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatMoney, formatNumber } from "../lib/format";
import { matchesSearch } from "../lib/search";
import { downloadReportWorkbook, type ExportReport } from "./xlsx-export";
import { usePmsActions } from "./pms-action-context";

type CatalogItem = {
  key: string;
  label: string;
  group: string;
  description: string;
};
type Column = { key: string; label: string; type?: string };
type ReportData = {
  catalog: readonly CatalogItem[];
  report: CatalogItem;
  title: string;
  description: string;
  generatedAt: string;
  filters: Filters;
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  summary: Array<{ label: string; value: number | string; format?: string }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  export: { allowed: boolean; maxRows: number; masked: boolean };
  exportId?: string;
};
type Filters = {
  q: string;
  from: string;
  to: string;
  status: string;
  source: string;
  roomTypeId: string;
  scope: string;
};
type RoomType = { id: string; code: string; name: string; active?: boolean };
type PageSize = 25 | 50 | 100;
type SavedReportView = {
  id: string;
  name: string;
  reportKey: string;
  filters: Filters;
  pageSize: PageSize;
};

const catalogFallback: CatalogItem[] = [
  {
    key: "reservations",
    label: "예약 상세",
    group: "예약",
    description: "예약과 고객, 객실, 채널, 잔액",
  },
  {
    key: "booking_curve",
    label: "시간대별 예약곡선",
    group: "예약",
    description: "0–6·6–12·12–18·18–24시 BOOK",
  },
  {
    key: "occupancy",
    label: "점유율 · ADR · RevPAR",
    group: "매출",
    description: "일자·타입별 핵심 영업 지표",
  },
  {
    key: "yoy",
    label: "전년 대비 예약현황",
    group: "매출",
    description: "월별 BOOK·REV YoY",
  },
  {
    key: "financials",
    label: "정산 · 전표",
    group: "정산",
    description: "매출·결제·환불 원장",
  },
  {
    key: "accounting_journal",
    label: "회계 분개장 · 손익",
    group: "회계",
    description: "차변·대변과 매출·비용·손익",
  },
  {
    key: "channel_settlements",
    label: "채널 판매가 · 입금가",
    group: "회계",
    description: "수수료·입금가 계약 정산",
  },
  {
    key: "channel_deposits",
    label: "채널 입금관리",
    group: "회계",
    description: "입금처리·복구·미입금 대사",
  },
  {
    key: "ar",
    label: "매출채권 · 미수금",
    group: "정산",
    description: "청구와 미수 잔액",
  },
  {
    key: "deferred_settlements",
    label: "후불 정산관리",
    group: "정산",
    description: "후불 계정 정산 상태",
  },
  {
    key: "housekeeping",
    label: "객실 · 하우스키핑",
    group: "객실",
    description: "객실 및 청소 작업",
  },
  {
    key: "groups",
    label: "그룹 · 블록",
    group: "세일즈",
    description: "블록 할당과 픽업",
  },
  {
    key: "channels",
    label: "채널 · 인터페이스",
    group: "연동",
    description: "OTA 송수신 결과",
  },
  {
    key: "audit",
    label: "감사 로그",
    group: "감사",
    description: "사용자 변경 이력",
  },
  {
    key: "room_inventory",
    label: "객실 마스터",
    group: "객실",
    description: "타입과 객실 현황",
  },
  {
    key: "search_quality",
    label: "검색 품질 · 경보",
    group: "운영",
    description: "일별 무결과율·지연율·교정률",
  },
];
const statusOptions: Record<string, Array<[string, string]>> = {
  reservations: [
    ["DUE_IN", "도착 예정"],
    ["IN_HOUSE", "투숙 중"],
    ["CHECKED_OUT", "체크아웃"],
    ["CANCELLED", "취소"],
    ["NO_SHOW", "노쇼"],
  ],
  booking_curve: [
    ["DUE_IN", "도착 예정"],
    ["IN_HOUSE", "투숙 중"],
    ["CHECKED_OUT", "체크아웃"],
    ["CANCELLED", "취소"],
    ["NO_SHOW", "노쇼"],
  ],
  financials: [
    ["CHARGE", "매출"],
    ["PAYMENT", "결제"],
    ["REFUND", "환불"],
    ["CHARGE_REVERSAL", "매출 반대전표"],
    ["PAYMENT_REVERSAL", "결제 반대전표"],
  ],
  accounting_journal: [
    ["REVENUE", "매출"],
    ["EXPENSE", "비용"],
    ["ADJUSTMENT", "조정"],
    ["CHANNEL_SETTLEMENT", "채널 정산"],
    ["REVERSAL", "반대전표"],
  ],
  channel_settlements: [
    ["ACCRUED", "정산 대기"],
    ["PAID", "입금·지급 완료"],
    ["HELD", "보류"],
    ["VOID", "무효"],
  ],
  search_quality: [
    ["HEALTHY", "정상"],
    ["WATCH", "관찰"],
    ["CRITICAL", "위험"],
    ["LEARNING", "표본 수집 중"],
  ],
  channel_deposits: [
    ["ACCRUED", "미입금"],
    ["PAID", "입금 완료"],
    ["HELD", "보류"],
    ["VOID", "무효"],
  ],
  ar: [
    ["OPEN", "미수"],
    ["PAID", "완납"],
  ],
  deferred_settlements: [
    ["OPEN", "미수"],
    ["PAID", "완납"],
  ],
  housekeeping: [
    ["DIRTY", "청소 필요"],
    ["CLEAN", "청소 완료"],
    ["INSPECTED", "점검 완료"],
    ["OUT_OF_SERVICE", "판매 중지"],
  ],
  groups: [
    ["TENTATIVE", "잠정"],
    ["DEFINITE", "확정"],
    ["CUTOFF", "컷오프"],
    ["CANCELLED", "취소"],
  ],
  channels: [
    ["ACKED", "성공"],
    ["FAILED", "실패"],
  ],
  room_inventory: [
    ["DIRTY", "청소 필요"],
    ["CLEAN", "청소 완료"],
    ["INSPECTED", "점검 완료"],
    ["OUT_OF_SERVICE", "판매 중지"],
  ],
};
const money = formatMoney;
const number = formatNumber;
const cellValue = (value: unknown, type?: string) =>
  value == null || value === ""
    ? "—"
    : type === "currency"
      ? money(value)
      : type === "percent"
        ? `${number(value)}%`
        : type === "number"
          ? number(value)
          : String(value);
const REPORT_PREFERENCES = "talos:report-preferences:v1";
const reportKeywordPlaceholders: Record<string, string> = {
  reservations: "예약번호, 고객명, 전화번호, 객실, 메모",
  booking_curve: "예약번호, 고객명, 채널, 객실 타입",
  occupancy: "객실 타입 코드 또는 타입명",
  financials: "거래 코드, 설명, 예약번호, 고객명",
  accounting_journal: "전표번호, 적요, 거래처, 계정, 부서",
  channel_settlements: "채널, 예약번호, 계약 또는 상태",
  channel_deposits: "채널, 예약번호, 입금 메모, 회계 전표",
  ar: "청구서, 거래처 계정, 예약번호",
  deferred_settlements: "청구서, 거래처, 예약번호, 수납 메모",
  yoy: "예약번호, 고객명, 채널, 객실 타입",
  housekeeping: "객실번호, 타입, 담당자, 메모",
  groups: "블록 코드, 블록명, 회사, 그룹",
  channels: "채널, 전송 대상, 오류 코드 또는 메시지",
  audit: "사용자, 작업, 엔터티 또는 식별자",
  room_inventory: "객실번호, 타입 코드, 타입명, 객실 특성",
};
function readPreferences() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(REPORT_PREFERENCES) || "{}",
    ) as { favorites?: string[]; recent?: string[]; views?: SavedReportView[] };
    return {
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.slice(0, 12)
        : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, 5) : [],
      views: Array.isArray(parsed.views) ? parsed.views.slice(0, 12) : [],
    };
  } catch {
    return { favorites: [], recent: [], views: [] };
  }
}
function isoDaysBefore(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export default function ReportsCenter({
  businessDate,
  roomTypes,
  canSettle,
}: {
  businessDate: string;
  roomTypes: RoomType[];
  canSettle: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { act, busy } = usePmsActions();
  const requestedReport = searchParams.get("report") || "reservations";
  const initialReport = catalogFallback.some(
    (item) => item.key === requestedReport,
  )
    ? requestedReport
    : "reservations";
  const initialFilters: Filters = {
    q: searchParams.get("q") || "",
    from: searchParams.get("from") || businessDate,
    to: searchParams.get("to") || businessDate,
    status: searchParams.get("status") || "",
    source: searchParams.get("source") || "",
    roomTypeId: searchParams.get("roomTypeId") || "",
    scope: searchParams.get("scope") || "",
  };
  const requestedPageSize = Number(searchParams.get("pageSize"));
  const initialPageSize = ([25, 50, 100] as const).includes(
    requestedPageSize as PageSize,
  )
    ? (requestedPageSize as PageSize)
    : 25;
  const [catalog, setCatalog] =
      useState<readonly CatalogItem[]>(catalogFallback),
    [reportKey, setReportKey] = useState(initialReport),
    [filters, setFilters] = useState<Filters>(initialFilters),
    [applied, setApplied] = useState<Filters>(initialFilters),
    [page, setPage] = useState(
      Math.max(1, Number(searchParams.get("page")) || 1),
    ),
    [pageSize, setPageSize] = useState<PageSize>(initialPageSize),
    [data, setData] = useState<ReportData | null>(null),
    [loading, setLoading] = useState(true),
    [exporting, setExporting] = useState(""),
    [exportIntent, setExportIntent] = useState<"XLSX" | "CSV" | null>(null),
    [error, setError] = useState("");
  const [settlementIntent, setSettlementIntent] = useState<{
      mode: "receipt" | "restore";
      row: Record<string, unknown>;
    } | null>(null),
    [settlementDate, setSettlementDate] = useState(businessDate),
    [settlementMemo, setSettlementMemo] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]),
    [recent, setRecent] = useState<string[]>([]),
    [savedViews, setSavedViews] = useState<SavedReportView[]>([]),
    [viewName, setViewName] = useState(""),
    [catalogQuery, setCatalogQuery] = useState(""),
    [roomTypeQuery, setRoomTypeQuery] = useState("");
  const persistPreferences = (next: {
    favorites?: string[];
    recent?: string[];
    views?: SavedReportView[];
  }) => {
    const value = {
      favorites: next.favorites ?? favorites,
      recent: next.recent ?? recent,
      views: next.views ?? savedViews,
    };
    window.localStorage.setItem(REPORT_PREFERENCES, JSON.stringify(value));
  };
  const query = useMemo(() => {
    const params = new URLSearchParams({
      view: "report",
      report: reportKey,
      from: applied.from,
      to: applied.to,
      page: String(page),
      pageSize: String(pageSize),
    });
    for (const key of ["q", "status", "source", "roomTypeId", "scope"] as const)
      if (applied[key]) params.set(key, applied[key]);
    return params.toString();
  }, [reportKey, applied, page, pageSize]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/pms?${query}`, { signal });
        const json = (await response.json()) as ReportData & { error?: string };
        if (!response.ok)
          throw new Error(json.error || "리포트를 조회하지 못했습니다.");
        setData(json);
        setCatalog(json.catalog);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setError(
          reason instanceof Error
            ? reason.message
            : "리포트를 조회하지 못했습니다.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [query],
  );
  // The effect synchronizes the selected server-side report query with the table.
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const visible = new URLSearchParams({ report: reportKey });
    if (applied.from !== businessDate) visible.set("from", applied.from);
    if (applied.to !== businessDate) visible.set("to", applied.to);
    for (const key of ["q", "status", "source", "roomTypeId", "scope"] as const)
      if (applied[key]) visible.set(key, applied[key]);
    if (page > 1) visible.set("page", String(page));
    if (pageSize !== 25) visible.set("pageSize", String(pageSize));
    const next = `/reports?${visible.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next)
      router.replace(next, { scroll: false });
  }, [applied, businessDate, page, pageSize, reportKey, router]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const preferences = readPreferences();
      setFavorites(preferences.favorites);
      setRecent(preferences.recent);
      setSavedViews(preferences.views);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  function changeReport(key: string) {
    setReportKey(key);
    setPage(1);
    setRoomTypeQuery("");
    setFilters((current) => ({
      ...current,
      status: "",
      source: "",
      roomTypeId: "",
      scope: "",
    }));
    setApplied((current) => ({
      ...current,
      status: "",
      source: "",
      roomTypeId: "",
      scope: "",
    }));
    const next = [key, ...recent.filter((item) => item !== key)].slice(0, 5);
    setRecent(next);
    persistPreferences({ recent: next });
  }
  function search(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setApplied(filters);
  }
  function resetFilters() {
    const reset = {
      q: "",
      from: businessDate,
      to: businessDate,
      status: "",
      source: "",
      roomTypeId: "",
      scope: "",
    };
    setFilters(reset);
    setApplied(reset);
    setRoomTypeQuery("");
    setPage(1);
  }
  function toggleFavorite(key: string) {
    const next = favorites.includes(key)
      ? favorites.filter((item) => item !== key)
      : [...favorites, key];
    setFavorites(next);
    persistPreferences({ favorites: next });
  }
  function saveView() {
    const name = viewName.trim().slice(0, 30);
    if (!name) return;
    const next = [
      { id: crypto.randomUUID(), name, reportKey, filters: applied, pageSize },
      ...savedViews,
    ].slice(0, 12);
    setSavedViews(next);
    setViewName("");
    persistPreferences({ views: next });
  }
  function applyView(view: SavedReportView) {
    const normalized = { ...view.filters, scope: view.filters.scope || "" };
    setReportKey(view.reportKey);
    setFilters(normalized);
    setApplied(normalized);
    setPageSize(view.pageSize);
    setRoomTypeQuery("");
    setPage(1);
  }
  function removeView(id: string) {
    const next = savedViews.filter((view) => view.id !== id);
    setSavedViews(next);
    persistPreferences({ views: next });
  }
  async function exportRows(format: "XLSX" | "CSV") {
    setExporting(format);
    setError("");
    try {
      const response = await fetch("/api/pms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          action: "export_report",
          format,
          report: reportKey,
          ...applied,
        }),
      });
      const json = (await response.json()) as ReportData & { error?: string };
      if (!response.ok)
        throw new Error(json.error || "내보내기를 생성하지 못했습니다.");
      if (format === "XLSX") downloadReportWorkbook(json as ExportReport);
      else downloadCsv(json);
      setData((current) =>
        current ? { ...current, exportId: json.exportId } : current,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "내보내기를 생성하지 못했습니다.",
      );
    } finally {
      setExporting("");
    }
  }
  function openSettlement(
    mode: "receipt" | "restore",
    row: Record<string, unknown>,
  ) {
    setSettlementIntent({ mode, row });
    setSettlementDate(businessDate);
    setSettlementMemo(mode === "receipt" ? String(row.deposit_memo || "") : "");
  }
  async function submitSettlement(event: React.FormEvent) {
    event.preventDefault();
    if (!settlementIntent) return;
    const payload: Record<string, string> =
      settlementIntent.mode === "receipt"
        ? {
            settlementId: String(settlementIntent.row.settlement_id),
            depositDate: settlementDate,
            memo: settlementMemo,
          }
        : {
            settlementId: String(settlementIntent.row.settlement_id),
            restoreDate: settlementDate,
            reason: settlementMemo,
          };
    const ok = await act(
      settlementIntent.mode === "receipt"
        ? "mark_channel_settlement_paid"
        : "restore_channel_settlement_payment",
      payload,
    );
    if (ok) {
      setSettlementIntent(null);
      await load();
    }
  }
  function downloadCsv(report: ReportData) {
    const quote = (value: unknown) =>
        `"${String(value ?? "").replaceAll('"', '""')}"`,
      rows = [
        report.columns.map((column) => quote(column.label)).join(","),
        ...report.rows.map((row) =>
          report.columns.map((column) => quote(row[column.key])).join(","),
        ),
      ],
      blob = new Blob(["\ufeff", rows.join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
      url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Talos_${report.report.key}_${report.filters.from}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const statuses = statusOptions[reportKey] || [];
  const visibleCatalog = catalog.filter((item) =>
    matchesSearch([item.label, item.group, item.description], catalogQuery),
  );
  const catalogGroups = Array.from(
    new Set(visibleCatalog.map((item) => item.group)),
  );
  const visibleRoomTypes = roomTypes
    .filter((type) => type.active !== false)
    .filter((type) => matchesSearch([type.code, type.name], roomTypeQuery));
  const keywordPlaceholder =
    reportKeywordPlaceholders[reportKey] || "키워드 검색";
  const activeFilters = [
    applied.q && `키워드 ${applied.q}`,
    applied.from !== businessDate || applied.to !== businessDate
      ? `${applied.from}~${applied.to}`
      : "",
    applied.status && `상태 ${applied.status}`,
    applied.source && `채널·사용자 ${applied.source}`,
    applied.roomTypeId && "객실 타입",
    applied.scope === "EXCLUDE_ONSITE" && "수기·현장결제 제외",
  ].filter(Boolean) as string[];
  return (
    <section className="report-workspace">
      <aside className="report-catalog">
        <div className="report-catalog-head">
          <span>REPORT LIBRARY</span>
          <b>{catalog.length}개 표준 리포트</b>
          <input
            aria-label="리포트 찾기"
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            placeholder="리포트 이름·업무 검색"
          />
        </div>
        {recent.length > 0 && (
          <div className="report-recent">
            <b>최근 사용</b>
            {recent.map((key) => {
              const item = catalog.find((candidate) => candidate.key === key);
              return item ? (
                <button
                  type="button"
                  key={key}
                  onClick={() => changeReport(key)}
                >
                  {item.label}
                </button>
              ) : null;
            })}
          </div>
        )}
        {visibleCatalog.length === 0 && (
          <div className="empty-state">
            <b>일치하는 리포트가 없습니다.</b>
            <p>리포트 이름이나 업무 키워드를 바꿔 보세요.</p>
          </div>
        )}
        {catalogGroups.map((group) => (
          <section className="report-catalog-group" key={group}>
            <h3>{group}</h3>
            {visibleCatalog
              .filter((item) => item.group === group)
              .map((item) => (
                <div
                  className={`report-catalog-item ${reportKey === item.key ? "on" : ""}`}
                  key={item.key}
                >
                  <button type="button" onClick={() => changeReport(item.key)}>
                    <b>{item.label}</b>
                    <small>{item.description}</small>
                  </button>
                  <button
                    type="button"
                    className="report-favorite"
                    aria-label={`${item.label} ${favorites.includes(item.key) ? "즐겨찾기 해제" : "즐겨찾기"}`}
                    onClick={() => toggleFavorite(item.key)}
                  >
                    {favorites.includes(item.key) ? "★" : "☆"}
                  </button>
                </div>
              ))}
          </section>
        ))}
      </aside>
      <div className="report-main">
        <div className="report-hero">
          <div>
            <p className="eyebrow">SERVER-SIDE REPORTING · 최대 367일</p>
            <h2>
              {data?.title ||
                catalog.find((item) => item.key === reportKey)?.label}
            </h2>
            <p>
              {data?.description ||
                catalog.find((item) => item.key === reportKey)?.description}
            </p>
          </div>
          <div className="report-export-actions">
            <button
              type="button"
              className="secondary"
              disabled={!data?.export.allowed || !!exporting}
              onClick={() => setExportIntent("CSV")}
            >
              {exporting === "CSV" ? "생성 중…" : "CSV"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!data?.export.allowed || !!exporting}
              onClick={() => setExportIntent("XLSX")}
            >
              {exporting === "XLSX" ? "Excel 생성 중…" : "↓ Excel 내보내기"}
            </button>
          </div>
        </div>
        <form className="report-filters" onSubmit={search}>
          <label className="wide">
            <span>키워드</span>
            <input
              value={filters.q}
              onChange={(event) =>
                setFilters({ ...filters, q: event.target.value })
              }
              placeholder={keywordPlaceholder}
              aria-label={`${data?.title || reportKey} 키워드 검색`}
            />
          </label>
          <div className="report-date-presets">
            <button
              type="button"
              onClick={() =>
                setFilters({ ...filters, from: businessDate, to: businessDate })
              }
            >
              오늘
            </button>
            <button
              type="button"
              onClick={() =>
                setFilters({
                  ...filters,
                  from: isoDaysBefore(businessDate, 6),
                  to: businessDate,
                })
              }
            >
              최근 7일
            </button>
            <button
              type="button"
              onClick={() =>
                setFilters({
                  ...filters,
                  from: isoDaysBefore(businessDate, 29),
                  to: businessDate,
                })
              }
            >
              최근 30일
            </button>
          </div>
          {reportKey === "channel_deposits" && (
            <div className="report-deposit-toggles">
              <button
                type="button"
                className={filters.status === "ACCRUED" ? "on" : ""}
                onClick={() =>
                  setFilters({
                    ...filters,
                    status: filters.status === "ACCRUED" ? "" : "ACCRUED",
                  })
                }
              >
                미입금만 보기
              </button>
              <button
                type="button"
                className={filters.scope === "EXCLUDE_ONSITE" ? "on" : ""}
                onClick={() =>
                  setFilters({
                    ...filters,
                    scope:
                      filters.scope === "EXCLUDE_ONSITE"
                        ? ""
                        : "EXCLUDE_ONSITE",
                  })
                }
              >
                수기·현장결제 제외
              </button>
            </div>
          )}
          <label>
            <span>시작일</span>
            <input
              type="date"
              value={filters.from}
              onChange={(event) =>
                setFilters({ ...filters, from: event.target.value })
              }
            />
          </label>
          <label>
            <span>종료일</span>
            <input
              type="date"
              value={filters.to}
              onChange={(event) =>
                setFilters({ ...filters, to: event.target.value })
              }
            />
          </label>
          <label>
            <span>상태</span>
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value })
              }
            >
              <option value="">전체 상태</option>
              {statuses.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {reportKey !== "search_quality" && (
            <>
              <label>
                <span>채널 / 사용자</span>
                <input
                  value={filters.source}
                  onChange={(event) =>
                    setFilters({ ...filters, source: event.target.value })
                  }
                  placeholder="예: Booking.com"
                />
              </label>
              <label>
                <span>객실 타입 검색</span>
                <input
                  value={roomTypeQuery}
                  onChange={(event) => setRoomTypeQuery(event.target.value)}
                  placeholder="코드·타입명"
                />
              </label>
              <label>
                <span>객실 타입</span>
                <select
                  value={filters.roomTypeId}
                  onChange={(event) =>
                    setFilters({ ...filters, roomTypeId: event.target.value })
                  }
                >
                  <option value="">전체 타입</option>
                  {visibleRoomTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code} · {type.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button className="secondary" type="button" onClick={resetFilters}>
            초기화
          </button>
          <button className="primary" type="submit">
            조회
          </button>
        </form>
        <div className="report-view-tools">
          <div className="report-active-filters">
            {activeFilters.length ? (
              activeFilters.map((filter) => <em key={filter}>{filter}</em>)
            ) : (
              <span>추가 필터 없음</span>
            )}
          </div>
          <div className="report-save-view">
            <input
              aria-label="저장할 조회 조건 이름"
              maxLength={30}
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              placeholder="예: 월말 OTA 정산"
            />
            <button
              type="button"
              className="secondary"
              disabled={!viewName.trim()}
              onClick={saveView}
            >
              현재 조건 저장
            </button>
          </div>
        </div>
        {savedViews.length > 0 && (
          <div className="report-saved-views">
            {savedViews.map((view) => (
              <span key={view.id}>
                <button type="button" onClick={() => applyView(view)}>
                  ☆ {view.name}
                </button>
                <button
                  type="button"
                  aria-label={`${view.name} 삭제`}
                  onClick={() => removeView(view.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {error && (
          <div className="report-error" role="alert">
            {error}
          </div>
        )}
        <div className="report-summary">
          {(data?.summary || []).map((item) => (
            <article key={item.label}>
              <span>{item.label}</span>
              <strong>
                {item.format === "currency"
                  ? money(item.value)
                  : item.format === "percent"
                    ? `${number(item.value)}%`
                    : number(item.value)}
              </strong>
            </article>
          ))}
        </div>
        <div className="report-table-wrap" aria-busy={loading}>
          <div className="report-table-meta">
            <span>
              {loading
                ? "조회 중…"
                : `${number(data?.pagination.total || 0)}행 · ${data?.generatedAt ? new Date(data.generatedAt).toLocaleString("ko-KR") : ""}`}
            </span>
            {data?.export.masked && <em>개인정보 마스킹됨</em>}
            {data?.exportId && (
              <em>내보내기 기록 {data.exportId.slice(0, 8)}</em>
            )}
            <label>
              페이지당{" "}
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value) as PageSize);
                  setPage(1);
                }}
              >
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
          </div>
          <div className="report-scroll">
            <table>
              <thead>
                <tr>
                  {data?.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                  {reportKey === "channel_deposits" && canSettle && (
                    <th>업무</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {!loading &&
                  data?.rows.map((row, index) => (
                    <tr key={String(row.settlement_id || index)}>
                      {data.columns.map((column) => (
                        <td key={column.key} className={column.type || "text"}>
                          {cellValue(row[column.key], column.type)}
                        </td>
                      ))}
                      {reportKey === "channel_deposits" && canSettle && (
                        <td className="report-row-action">
                          {row.status === "ACCRUED" ? (
                            <button
                              type="button"
                              onClick={() => openSettlement("receipt", row)}
                            >
                              입금처리
                            </button>
                          ) : row.status === "PAID" ? (
                            <button
                              type="button"
                              className="restore"
                              onClick={() => openSettlement("restore", row)}
                            >
                              입금복구
                            </button>
                          ) : (
                            <span>—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                {!loading && data?.rows.length === 0 && (
                  <tr>
                    <td
                      className="empty"
                      colSpan={
                        data.columns.length +
                        (reportKey === "channel_deposits" && canSettle ? 1 : 0)
                      }
                    >
                      조건에 맞는 데이터가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="report-pagination">
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => value - 1)}
            >
              ← 이전
            </button>
            <span>
              {data?.pagination.page || page} /{" "}
              {data?.pagination.totalPages || 1}
            </span>
            <button
              disabled={page >= (data?.pagination.totalPages || 1) || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              다음 →
            </button>
          </div>
        </div>
      </div>
      {exportIntent && data && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExportIntent(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-export-title"
            className="cashier-modal report-export-dialog"
          >
            <div className="drawer-head">
              <div>
                <p>REPORT EXPORT</p>
                <h2 id="report-export-title">{exportIntent} 내보내기 확인</h2>
              </div>
              <button
                type="button"
                aria-label="내보내기 닫기"
                onClick={() => setExportIntent(null)}
              >
                ×
              </button>
            </div>
            <p className="form-intro">
              현재 적용된 조건으로 서버에서 전체 내보내기 데이터를 다시
              검증합니다. 이 작업은 사용자·호텔·필터·행 수와 함께 감사 로그에
              남습니다.
            </p>
            <dl>
              <div>
                <dt>리포트</dt>
                <dd>{data.title}</dd>
              </div>
              <div>
                <dt>기간</dt>
                <dd>
                  {applied.from} ~ {applied.to}
                </dd>
              </div>
              <div>
                <dt>조회 행</dt>
                <dd>{number(data.pagination.total)}행</dd>
              </div>
              <div>
                <dt>개인정보</dt>
                <dd>
                  {data.export.masked
                    ? "권한에 따라 마스킹"
                    : "내보내기 권한 적용"}
                </dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setExportIntent(null)}
              >
                취소
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const format = exportIntent;
                  setExportIntent(null);
                  await exportRows(format);
                }}
              >
                {exportIntent} 생성
              </button>
            </div>
          </section>
        </div>
      )}
      {settlementIntent && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setSettlementIntent(null)
          }
        >
          <form
            className="cashier-modal report-settlement-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settlement-dialog-title"
            onSubmit={submitSettlement}
          >
            <div className="drawer-head">
              <div>
                <p>CHANNEL DEPOSIT</p>
                <h2 id="settlement-dialog-title">
                  {settlementIntent.mode === "receipt"
                    ? "채널 입금처리"
                    : "채널 입금복구"}
                </h2>
              </div>
              <button
                type="button"
                aria-label="닫기"
                onClick={() => setSettlementIntent(null)}
              >
                ×
              </button>
            </div>
            <div className="report-settlement-overview">
              <span>
                {String(
                  settlementIntent.row.channel_name ||
                    settlementIntent.row.provider,
                )}
              </span>
              <b>
                {String(
                  settlementIntent.row.confirmation_no || "예약번호 없음",
                )}
              </b>
              <strong>{money(settlementIntent.row.hotel_net_amount)}</strong>
              <small>
                {settlementIntent.mode === "receipt"
                  ? `예정일 ${String(settlementIntent.row.due_date)}`
                  : `기존 입금일 ${String(settlementIntent.row.deposit_date)}`}
              </small>
            </div>
            <label>
              <span>
                {settlementIntent.mode === "receipt" ? "입금일" : "복구일"}
              </span>
              <input
                type="date"
                max={businessDate}
                required
                value={settlementDate}
                onChange={(event) => setSettlementDate(event.target.value)}
              />
            </label>
            <label>
              <span>
                {settlementIntent.mode === "receipt"
                  ? "입금 메모"
                  : "복구 사유 (필수)"}
              </span>
              <textarea
                required={settlementIntent.mode === "restore"}
                minLength={settlementIntent.mode === "restore" ? 2 : undefined}
                maxLength={500}
                value={settlementMemo}
                onChange={(event) => setSettlementMemo(event.target.value)}
                placeholder={
                  settlementIntent.mode === "receipt"
                    ? "입금자명, 계좌, 대사 메모"
                    : "복구 사유를 2자 이상 입력하세요."
                }
              />
            </label>
            <p className="form-intro">
              {settlementIntent.mode === "receipt"
                ? "입금과 동시에 채널 미수금 회계 전표와 불변 입금 이력이 생성됩니다."
                : "원 입금 전표는 삭제되지 않고 반대전표가 생성되며, 정산 건은 미입금 상태로 돌아갑니다."}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setSettlementIntent(null)}
              >
                취소
              </button>
              <button
                className={
                  settlementIntent.mode === "restore" ? "danger" : "primary"
                }
                disabled={Boolean(busy)}
              >
                {busy
                  ? "처리 중…"
                  : settlementIntent.mode === "receipt"
                    ? "입금 확정"
                    : "입금 복구"}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
