"use client";

/** Hotel subledger, profit-and-loss and channel settlement workspace. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { addIsoDays, formatMoney } from "../lib/format";
import { ListSearch } from "./list-search";
import { usePmsActions } from "./pms-action-context";

type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  category: string;
  department: string | null;
  active: boolean;
};
type Entry = {
  id: string;
  entry_no: string;
  business_date: string;
  entry_type: string;
  source_type: string;
  description: string;
  vendor: string | null;
  status: string;
  created_by: string;
  total_debit: number;
  total_credit: number;
};
type Line = {
  id: string;
  journal_entry_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit: number;
  credit: number;
  department: string | null;
  memo: string | null;
};
type Settlement = {
  id: string;
  connection_id: string;
  reservation_id: string | null;
  business_date: string;
  gross_sell_amount: number;
  channel_cost_amount: number;
  hotel_net_amount: number;
  due_date: string;
  status: string;
  provider: string;
  connection_name: string;
  contract_type: string;
  commission_percent: number;
  confirmation_no: string | null;
};
type Contract = {
  id: string;
  connection_id: string;
  contract_type: string;
  commission_percent: number;
  provider: string;
  connection_name: string;
};
type Reservation = {
  id: string;
  confirmation_no: string;
  guest_name: string;
  source: string;
  arrival_date: string;
  departure_date: string;
  nightly_rate: number;
};
type AccountingData = {
  range: { from: string; to: string };
  summary: {
    revenue: number;
    expense: number;
    operatingProfit: number;
    receivable: number;
    channelCost: number;
    journalCount: number;
  };
  accounts: Account[];
  entries: Entry[];
  lines: Line[];
  settlements: Settlement[];
  contracts: Contract[];
  reservations: Reservation[];
};
type Modal = { type: "journal" | "reverse" | "accrue"; entry?: Entry } | null;

const money = formatMoney;
const addDays = addIsoDays;
const accountType: Record<string, string> = {
  ASSET: "자산",
  LIABILITY: "부채",
  EQUITY: "자본",
  REVENUE: "매출",
  EXPENSE: "비용",
};

export default function AccountingCenter({
  businessDate,
  canWrite,
}: {
  businessDate: string;
  canWrite: boolean;
}) {
  const { act } = usePmsActions();
  // The range is applied explicitly so journal and settlement KPIs always come from
  // one server projection. Local search narrows visible journal headers only and
  // deliberately does not recalculate the authoritative period totals.
  const [from, setFrom] = useState(addDays(businessDate, -30)),
    [to, setTo] = useState(businessDate),
    [applied, setApplied] = useState({
      from: addDays(businessDate, -30),
      to: businessDate,
    }),
    [data, setData] = useState<AccountingData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [tab, setTab] = useState<"journal" | "settlements" | "accounts">("journal"),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState<Modal>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ view: "accounting", ...applied }),
        response = await fetch(`/api/pms?${params}`, { cache: "no-store" }),
        json = (await response.json()) as AccountingData & { error?: string };
      if (!response.ok)
        throw new Error(json.error || "회계 원장을 불러오지 못했습니다.");
      setData(json);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "회계 원장을 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [applied]);
  // The effect synchronizes the selected server-side accounting range.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const filteredEntries = useMemo(
    () =>
      data?.entries.filter((entry) =>
        `${entry.entry_no} ${entry.description} ${entry.vendor || ""} ${entry.created_by}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) || [],
    [data, query],
  );
  async function mutate(action: string, payload: Record<string, string>) {
    // Reload after the command rather than patching financial state optimistically;
    // the server may create multiple balanced lines and settlement-derived postings.
    if (await act(action, payload)) {
      setModal(null);
      await load();
      return true;
    }
    return false;
  }
  return (
    <>
      <section className="accounting-shell">
        <div className="accounting-hero">
          <div>
            <p className="eyebrow">HOTEL FINANCE CONTROL</p>
            <h2>회계 & 손익</h2>
            <p>
              매출·비용·채널 정산을 변경 불가능한 복식부기 원장으로 관리합니다.
            </p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setApplied({ from, to });
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
            <label>
              <span>종료일</span>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary">조회</button>
          </form>
        </div>
        {error && (
          <div className="report-error" role="alert">
            {error}
          </div>
        )}
        <section className="accounting-kpis">
          <article>
            <span>총 매출</span>
            <strong>{money(data?.summary.revenue || 0)}</strong>
            <small>대변 매출 계정 순액</small>
          </article>
          <article>
            <span>총 비용</span>
            <strong>{money(data?.summary.expense || 0)}</strong>
            <small>차변 비용 계정 순액</small>
          </article>
          <article
            className={
              (data?.summary.operatingProfit || 0) < 0 ? "negative" : "positive"
            }
          >
            <span>영업 손익</span>
            <strong>{money(data?.summary.operatingProfit || 0)}</strong>
            <small>매출 − 비용</small>
          </article>
          <article>
            <span>채널 미수</span>
            <strong>{money(data?.summary.receivable || 0)}</strong>
            <small>정산 대기 호텔 입금액</small>
          </article>
          <article>
            <span>채널 유통 비용</span>
            <strong>{money(data?.summary.channelCost || 0)}</strong>
            <small>수수료·판매가 차액</small>
          </article>
        </section>
        <div className="accounting-tabs">
          <button
            className={tab === "journal" ? "on" : ""}
            onClick={() => setTab("journal")}
          >
            총계정 원장 <b>{data?.entries.length || 0}</b>
          </button>
          <button
            className={tab === "settlements" ? "on" : ""}
            onClick={() => setTab("settlements")}
          >
            채널 정산 <b>{data?.settlements.length || 0}</b>
          </button>
          <button
            className={tab === "accounts" ? "on" : ""}
            onClick={() => setTab("accounts")}
          >
            계정과목 <b>{data?.accounts.length || 0}</b>
          </button>
        </div>
        {tab === "journal" && (
          <section className="panel accounting-panel">
            <div className="panel-title">
              <div>
                <h2>복식부기 분개장</h2>
                <p>
                  확정 전표는 삭제하지 않고 동일 금액의 반대전표로만 정정합니다.
                </p>
              </div>
              <div className="accounting-actions">
                <ListSearch value={query} onChange={setQuery} label="회계 전표 검색" placeholder="전표번호·적요·거래처" count={filteredEntries.length}/>
                {canWrite && (
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "journal" })}
                  >
                    ＋ 수기 전표
                  </button>
                )}
              </div>
            </div>
            <div className="accounting-table">
              <div className="accounting-row head">
                <span>영업일 / 전표</span>
                <span>유형 / 출처</span>
                <span>적요</span>
                <span>차변</span>
                <span>대변</span>
                <span>상태</span>
                <span />
              </div>
              {filteredEntries.map((entry) => (
                <JournalRow
                  key={entry.id}
                  entry={entry}
                  lines={
                    data?.lines.filter(
                      (line) => line.journal_entry_id === entry.id,
                    ) || []
                  }
                  canWrite={canWrite}
                  reverse={() => setModal({ type: "reverse", entry })}
                />
              ))}
              {!loading && !filteredEntries.length && (
                <div className="master-empty">
                  조회 기간에 확정된 회계 전표가 없습니다.
                </div>
              )}
            </div>
          </section>
        )}
        {tab === "settlements" && (
          <section className="panel accounting-panel">
            <div className="panel-title">
              <div>
                <h2>채널 정산 원장</h2>
                <p>
                  채널 판매가 → 유통 비용 → 호텔 입금가를 계약 방식별로
                  대사합니다.
                </p>
              </div>
              {canWrite && (
                <button
                  className="primary"
                  onClick={() => setModal({ type: "accrue" })}
                >
                  ＋ 예약 정산 발생
                </button>
              )}
            </div>
            <div className="settlement-summary-head">
              <span>채널 / 예약</span>
              <span>계약</span>
              <span>판매가</span>
              <span>채널 비용</span>
              <span>호텔 입금</span>
              <span>만기 / 상태</span>
              <span />
            </div>
            {data?.settlements.map((settlement) => (
              <div className="settlement-row" key={settlement.id}>
                <span>
                  <b>
                    {settlement.provider} · {settlement.connection_name}
                  </b>
                  <small>{settlement.confirmation_no || "예약 미연결"}</small>
                </span>
                <span>
                  <i
                    className={`contract-pill ${settlement.contract_type.toLowerCase()}`}
                  >
                    {settlement.contract_type === "COMMISSION"
                      ? `수수료 ${Number(settlement.commission_percent)}%`
                      : "입금가"}
                  </i>
                </span>
                <strong>{money(Number(settlement.gross_sell_amount))}</strong>
                <strong className="expense">
                  − {money(Number(settlement.channel_cost_amount))}
                </strong>
                <strong className="net">
                  {money(Number(settlement.hotel_net_amount))}
                </strong>
                <span>
                  <b>{settlement.due_date}</b>
                  <i
                    className={`status ${settlement.status === "PAID" ? "ready" : "warn"}`}
                  >
                    {settlement.status}
                  </i>
                </span>
                {canWrite && settlement.status === "ACCRUED" ? (
                  <button
                    className="secondary"
                    onClick={() =>
                      void mutate("mark_channel_settlement_paid", {
                        settlementId: settlement.id,
                      })
                    }
                  >
                    입금·지급 완료
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
            {!loading && !data?.settlements.length && (
              <div className="master-empty">
                조회 기간에 채널 정산 건이 없습니다.
              </div>
            )}
          </section>
        )}
        {tab === "accounts" && (
          <section className="panel accounting-panel">
            <div className="panel-title">
              <div>
                <h2>호텔 계정과목표</h2>
                <p>
                  USALI 대응 외부 코드를 붙일 수 있는 호텔 운영용 계정
                  체계입니다.
                </p>
              </div>
              <span className="live">CHART OF ACCOUNTS</span>
            </div>
            <div className="account-grid">
              {data?.accounts.map((account) => (
                <article key={account.id}>
                  <span>
                    <b>{account.code}</b>
                    <i>
                      {accountType[account.account_type] ||
                        account.account_type}
                    </i>
                  </span>
                  <h3>{account.name}</h3>
                  <p>
                    {account.category.replaceAll("_", " ")} ·{" "}
                    {account.department || "공통"}
                  </p>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
      {modal && data && (
        <AccountingModal
          mode={modal}
          data={data}
          businessDate={businessDate}
          close={() => setModal(null)}
          submit={mutate}
        />
      )}
    </>
  );
}

function JournalRow({
  entry,
  lines,
  canWrite,
  reverse,
}: {
  entry: Entry;
  lines: Line[];
  canWrite: boolean;
  reverse: () => void;
}) {
  // Detail lines remain collapsed for scanability, but the header is keyboard
  // operable and always shows both totals so an imbalance is visually obvious.
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="accounting-row"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        <span>
          <b>{entry.business_date}</b>
          <small>{entry.entry_no}</small>
        </span>
        <span>
          <b>{entry.entry_type}</b>
          <small>{entry.source_type}</small>
        </span>
        <span>
          <b>{entry.description}</b>
          <small>{entry.vendor || entry.created_by}</small>
        </span>
        <strong>{money(Number(entry.total_debit))}</strong>
        <strong>{money(Number(entry.total_credit))}</strong>
        <i className={`status ${entry.status === "POSTED" ? "ready" : ""}`}>
          {entry.status}
        </i>
        <span className="row-actions">
          {canWrite && entry.status === "POSTED" && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                reverse();
              }}
            >
              반대
            </button>
          )}
          <i>{open ? "⌃" : "⌄"}</i>
        </span>
      </div>
      {open && (
        <div className="journal-lines">
          {lines.map((line) => (
            <div key={line.id}>
              <span>
                <b>
                  {line.account_code} · {line.account_name}
                </b>
                <small>{line.department || line.memo || "공통"}</small>
              </span>
              <strong>
                {Number(line.debit) > 0 ? money(Number(line.debit)) : "—"}
              </strong>
              <strong>
                {Number(line.credit) > 0 ? money(Number(line.credit)) : "—"}
              </strong>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AccountingModal({
  mode,
  data,
  businessDate,
  close,
  submit,
}: {
  mode: NonNullable<Modal>;
  data: AccountingData;
  businessDate: string;
  close: () => void;
  submit: (action: string, payload: Record<string, string>) => Promise<boolean>;
}) {
  // One modal hosts three command shapes, but the server remains responsible for
  // double-entry balancing, reversal immutability, and channel-contract arithmetic.
  const [busy, setBusy] = useState(false),
    assets = data.accounts.filter(
      (account) => account.active !== false,
    ),
    [form, setForm] = useState({
      businessDate,
      entryType: "EXPENSE",
      debitAccountId:
        assets.find((account) => account.account_type === "EXPENSE")?.id ||
        assets[0]?.id ||
        "",
      creditAccountId:
        assets.find((account) => account.code === "1100")?.id ||
        assets[1]?.id ||
        "",
      amount: "",
      description: "",
      vendor: "",
      department: "OPERATIONS",
      reason: "",
      connectionId: data.contracts[0]?.connection_id || "",
      reservationId: data.reservations[0]?.id || "",
    }),
    set = (key: string, value: string) =>
      setForm((current) => ({ ...current, [key]: value })),
    contract = data.contracts.find(
      (item) => item.connection_id === form.connectionId,
    ),
    eligible = data.reservations.filter(
      (reservation) =>
        !data.settlements.some(
          (settlement) =>
            settlement.connection_id === form.connectionId &&
            settlement.reservation_id === reservation.id,
        ),
    );
  // Already accrued connection/reservation pairs are removed before selection to
  // prevent an accidental duplicate settlement; the database constraint is the
  // concurrent-request safety net.
  const config =
    mode.type === "journal"
      ? {
          tag: "DOUBLE-ENTRY",
          title: "수기 회계 전표",
          action: "post_accounting_entry",
        }
      : mode.type === "reverse"
        ? {
            tag: "IMMUTABLE LEDGER",
            title: "반대전표 생성",
            action: "reverse_accounting_entry",
          }
        : {
            tag: "CHANNEL RECONCILIATION",
            title: "예약 정산 발생",
            action: "accrue_channel_settlement",
          };
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
        aria-label={config.title}
        className="booking-modal accounting-modal"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await submit(config.action, {
              ...form,
              entryId: mode.entry?.id || "",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="drawer-head">
          <div>
            <p>{config.tag}</p>
            <h2>{config.title}</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        <div className="accounting-modal-body">
          {mode.type === "journal" && (
            <>
              <p className="form-intro">
                한 전표 안에서 차변과 대변을 동일 금액으로 확정합니다.
              </p>
              <div className="form-grid">
                <label>
                  <span>영업일</span>
                  <input
                    type="date"
                    required
                    value={form.businessDate}
                    onChange={(event) =>
                      set("businessDate", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>전표 유형</span>
                  <select
                    value={form.entryType}
                    onChange={(event) => set("entryType", event.target.value)}
                  >
                    <option value="EXPENSE">비용</option>
                    <option value="REVENUE">매출</option>
                    <option value="ADJUSTMENT">조정</option>
                  </select>
                </label>
                <label>
                  <span>차변 계정</span>
                  <select
                    value={form.debitAccountId}
                    onChange={(event) =>
                      set("debitAccountId", event.target.value)
                    }
                  >
                    {assets.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>대변 계정</span>
                  <select
                    value={form.creditAccountId}
                    onChange={(event) =>
                      set("creditAccountId", event.target.value)
                    }
                  >
                    {assets.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>금액</span>
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.amount}
                    onChange={(event) => set("amount", event.target.value)}
                  />
                </label>
                <label>
                  <span>부서 / 코스트센터</span>
                  <input
                    value={form.department}
                    onChange={(event) => set("department", event.target.value)}
                  />
                </label>
                <label className="span-2">
                  <span>적요</span>
                  <input
                    required
                    minLength={2}
                    value={form.description}
                    onChange={(event) => set("description", event.target.value)}
                    placeholder="예: 7월 세탁 용역비"
                  />
                </label>
                <label className="span-2">
                  <span>거래처</span>
                  <input
                    value={form.vendor}
                    onChange={(event) => set("vendor", event.target.value)}
                    placeholder="선택 입력"
                  />
                </label>
              </div>
            </>
          )}
          {mode.type === "reverse" && (
            <>
              <div className="reversal-card">
                <span>
                  <b>{mode.entry?.entry_no}</b>
                  <small>
                    {mode.entry?.business_date} · {mode.entry?.entry_type}
                  </small>
                </span>
                <strong>{money(Number(mode.entry?.total_debit || 0))}</strong>
                <p>{mode.entry?.description}</p>
              </div>
              <label className="stack-label">
                <span>반대전표 사유</span>
                <textarea
                  required
                  minLength={2}
                  value={form.reason}
                  onChange={(event) => set("reason", event.target.value)}
                  placeholder="원전표를 삭제하지 않고 반대 금액을 기록하는 사유"
                />
              </label>
            </>
          )}
          {mode.type === "accrue" && (
            <>
              <p className="form-intro">
                예약 판매가와 채널 계약을 기준으로 유통 비용과 호텔 입금액을
                계산해 회계 전표까지 생성합니다.
              </p>
              <div className="stack-form">
                <label>
                  <span>채널 계약</span>
                  <select
                    value={form.connectionId}
                    onChange={(event) => {
                      set("connectionId", event.target.value);
                      const first = data.reservations.find(
                        (reservation) =>
                          !data.settlements.some(
                            (settlement) =>
                              settlement.connection_id === event.target.value &&
                              settlement.reservation_id === reservation.id,
                          ),
                      );
                      set("reservationId", first?.id || "");
                    }}
                  >
                    {data.contracts.map((item) => (
                      <option key={item.id} value={item.connection_id}>
                        {item.provider} · {item.connection_name} ·{" "}
                        {item.contract_type === "COMMISSION"
                          ? `${Number(item.commission_percent)}%`
                          : "입금가"}
                      </option>
                    ))}
                  </select>
                </label>
                {contract && (
                  <div className="contract-explainer">
                    <b>
                      {contract.contract_type === "COMMISSION"
                        ? "수수료 계약"
                        : "입금가 계약"}
                    </b>
                    <span>
                      {contract.contract_type === "COMMISSION"
                        ? `판매가의 ${Number(contract.commission_percent)}%를 채널 비용·미지급금으로 인식합니다.`
                        : "투숙일별 입금가 합계와 판매가 차액을 채널 유통 비용으로 인식합니다."}
                    </span>
                  </div>
                )}
                <label>
                  <span>예약</span>
                  <select
                    required
                    value={form.reservationId}
                    onChange={(event) =>
                      set("reservationId", event.target.value)
                    }
                  >
                    <option value="">선택</option>
                    {eligible.map((reservation) => (
                      <option key={reservation.id} value={reservation.id}>
                        {reservation.confirmation_no} · {reservation.guest_name}{" "}
                        · {reservation.source}
                      </option>
                    ))}
                  </select>
                </label>
                {eligible.length === 0 && (
                  <div className="contract-warning">
                    이 채널에서 추가로 발생시킬 수 있는 예약 정산이 없습니다.
                  </div>
                )}
              </div>
            </>
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
              (mode.type === "accrue" && (!contract || !form.reservationId))
            }
          >
            {busy
              ? "원장 검증 중…"
              : mode.type === "reverse"
                ? "반대전표 확정"
                : mode.type === "accrue"
                  ? "정산·분개 확정"
                  : "전표 확정"}
          </button>
        </div>
      </form>
    </div>
  );
}
