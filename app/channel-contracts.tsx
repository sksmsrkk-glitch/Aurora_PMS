"use client";

/** Channel commission and net-rate contract editor. */

import { useState } from "react";

type Connection = {
  id: string;
  provider: string;
  name: string;
  status: string;
};
type Contract = {
  id: string;
  connection_id: string;
  contract_type: "COMMISSION" | "NET_RATE";
  commission_percent: number;
  settlement_cycle: string;
  payment_terms_days: number;
  currency: string;
  valid_from: string;
  valid_to: string | null;
  status: string;
  version: number;
  provider: string;
  connection_name: string;
};

export default function ChannelContracts({
  connections,
  contracts,
  businessDate,
  canWrite,
  act,
}: {
  connections: Connection[];
  contracts: Contract[];
  businessDate: string;
  canWrite: boolean;
  act: (action: string, payload: Record<string, string>) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<Connection | null>(null);
  return (
    <>
      <section className="panel contract-panel">
        <div className="panel-title">
          <div>
            <h2>채널 상업 계약</h2>
            <p>
              수수료형과 입금가형을 분리해 판매가·채널 비용·호텔 입금액을
              계산합니다.
            </p>
          </div>
          <span className="live">COMMERCIAL TERMS</span>
        </div>
        <div className="contract-card-grid">
          {connections.map((connection) => {
            const contract = contracts.find(
              (item) => item.connection_id === connection.id,
            );
            return (
              <article
                key={connection.id}
                className={!contract ? "needs-contract" : ""}
              >
                <span>
                  <b>{connection.provider}</b>
                  <i className={`status ${contract ? "ready" : "warn"}`}>
                    {contract ? contract.status : "설정 필요"}
                  </i>
                </span>
                <h3>{connection.name}</h3>
                {contract ? (
                  <>
                    <strong>
                      {contract.contract_type === "COMMISSION"
                        ? `판매가 수수료 ${Number(contract.commission_percent)}%`
                        : "호텔 입금가 계약"}
                    </strong>
                    <p>
                      {contract.settlement_cycle.replace("_", " ")} ·{" "}
                      {Number(contract.payment_terms_days)}일 후 정산
                    </p>
                    <small>
                      {contract.valid_from} ~ {contract.valid_to || "계속"}
                    </small>
                  </>
                ) : (
                  <>
                    <strong>계약 조건 미설정</strong>
                    <p>요금·정산 전에 계약 방식을 선택하세요.</p>
                  </>
                )}
                {canWrite && (
                  <button
                    className="secondary wide"
                    onClick={() => setSelected(connection)}
                  >
                    {contract ? "계약 편집" : "계약 설정"}
                  </button>
                )}
              </article>
            );
          })}
          {!connections.length && (
            <div className="master-empty">먼저 채널 연결을 생성하세요.</div>
          )}
        </div>
      </section>
      {selected && (
        <ContractModal
          connection={selected}
          contract={contracts.find(
            (item) => item.connection_id === selected.id,
          )}
          businessDate={businessDate}
          close={() => setSelected(null)}
          save={async (payload) => {
            if (await act("upsert_channel_contract", payload))
              setSelected(null);
          }}
        />
      )}
    </>
  );
}

function ContractModal({
  connection,
  contract,
  businessDate,
  close,
  save,
}: {
  connection: Connection;
  contract?: Contract;
  businessDate: string;
  close: () => void;
  save: (payload: Record<string, string>) => Promise<void>;
}) {
  const [form, setForm] = useState({
      contractType: contract?.contract_type || "COMMISSION",
      commissionPercent: String(contract?.commission_percent || 15),
      settlementCycle: contract?.settlement_cycle || "PER_STAY",
      paymentTermsDays: String(contract?.payment_terms_days || 30),
      validFrom: contract?.valid_from || businessDate,
      validTo: contract?.valid_to || "",
    }),
    [busy, setBusy] = useState(false),
    set = (key: string, value: string) =>
      setForm((current) => ({ ...current, [key]: value }));
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
        aria-label="채널 계약 편집"
        className="booking-modal contract-modal"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await save({ ...form, connectionId: connection.id });
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="drawer-head">
          <div>
            <p>
              {connection.provider} · {connection.name}
            </p>
            <h2>채널 계약 조건</h2>
          </div>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        <p className="form-intro">
          계약 유형은 예약 정산 시 채널 비용과 호텔 입금액의 계산 방식을
          결정합니다.
        </p>
        <div className="contract-choice">
          <label className={form.contractType === "COMMISSION" ? "on" : ""}>
            <input
              type="radio"
              name="contract"
              value="COMMISSION"
              checked={form.contractType === "COMMISSION"}
              onChange={(event) => set("contractType", event.target.value)}
            />
            <span>
              <b>수수료 계약</b>
              <small>
                호텔 판매가에서 일정 비율을 채널 수수료 비용·미지급금으로 인식
              </small>
            </span>
          </label>
          <label className={form.contractType === "NET_RATE" ? "on" : ""}>
            <input
              type="radio"
              name="contract"
              value="NET_RATE"
              checked={form.contractType === "NET_RATE"}
              onChange={(event) => set("contractType", event.target.value)}
            />
            <span>
              <b>입금가 계약</b>
              <small>
                채널 판매가와 별도로 호텔이 실제 입금받을 날짜별 금액을 관리
              </small>
            </span>
          </label>
        </div>
        <div className="form-grid">
          {form.contractType === "COMMISSION" && (
            <label>
              <span>수수료율 (%)</span>
              <input
                required
                type="number"
                min="0.0001"
                max="100"
                step="0.01"
                value={form.commissionPercent}
                onChange={(event) =>
                  set("commissionPercent", event.target.value)
                }
              />
            </label>
          )}
          <label>
            <span>정산 주기</span>
            <select
              value={form.settlementCycle}
              onChange={(event) => set("settlementCycle", event.target.value)}
            >
              <option value="PER_STAY">투숙 건별</option>
              <option value="WEEKLY">주간</option>
              <option value="MONTHLY">월간</option>
            </select>
          </label>
          <label>
            <span>입금·지급 조건</span>
            <div className="suffix-input">
              <input
                required
                type="number"
                min="0"
                max="365"
                value={form.paymentTermsDays}
                onChange={(event) =>
                  set("paymentTermsDays", event.target.value)
                }
              />
              <i>일 후</i>
            </div>
          </label>
          <label>
            <span>계약 시작일</span>
            <input
              required
              type="date"
              value={form.validFrom}
              onChange={(event) => set("validFrom", event.target.value)}
            />
          </label>
          <label>
            <span>
              계약 종료일 <small>선택</small>
            </span>
            <input
              type="date"
              min={form.validFrom}
              value={form.validTo}
              onChange={(event) => set("validTo", event.target.value)}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            닫기
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "계약 검증 중…" : "계약 저장"}
          </button>
        </div>
      </form>
    </div>
  );
}
