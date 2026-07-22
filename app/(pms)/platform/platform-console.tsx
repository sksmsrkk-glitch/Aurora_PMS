"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { WORKSPACE_LABELS } from "../../access-control";
import CompanyFooter from "../../company-footer";
import { PMS_WORKSPACES, type PmsWorkspace } from "../../pms-workspaces";

type Domain = {
  id: string;
  hostname: string;
  kind: string;
  status: string;
  primary: boolean;
};
type Portfolio = {
  property_id: string;
  property_name: string;
  property_code: string;
  property_slug: string;
  property_status: string;
  organization_id: string;
  organization_name: string;
  role: string;
  plan_code: string;
  subscription_status: string;
  room_limit: number | null;
  user_limit: number | null;
  active_rooms: number;
  active_users: number;
  pending_jobs: number;
  open_incidents: number;
  domains: Domain[];
};
type PlatformData = {
  currentPropertyId: string;
  organizationId: string;
  organizationName: string;
  identity: {
    email: string;
    displayName: string;
    assuranceLevel: "aal1" | "aal2";
  };
  portfolio: Portfolio[];
  subscription: Record<string, unknown> | null;
  entitlements: Array<{
    feature_key: string;
    enabled: boolean;
    limits: unknown;
  }>;
  imports: Array<Record<string, unknown>>;
  supportGrants: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  backups: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  configuration: {
    tenantBaseDomain: string | null;
    platformMfaRequired: boolean;
  };
};

function dateInSeoul() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function statusLabel(value: unknown) {
  return String(value || "-").replaceAll("_", " ");
}

export default function PlatformConsole() {
  const [data, setData] = useState<PlatformData | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/platform", { cache: "no-store" });
      if (response.status === 401) {
        window.location.replace("/login");
        return;
      }
      const payload = (await response.json()) as PlatformData & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "관리 데이터를 불러오지 못했습니다.");
      setData(payload);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "관리 데이터를 불러오지 못했습니다.",
      );
    }
  }, []);
  // Initial server projection is intentionally fetched after authentication.
  useEffect(() => {
    // The async loader synchronizes this client view with the authenticated API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function action(body: Record<string, unknown>) {
    setBusy(String(body.action));
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Record<string, unknown> & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "작업을 완료하지 못했습니다.");
      setNotice("요청이 안전하게 반영되었습니다.");
      await load();
      return payload;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "작업을 완료하지 못했습니다.",
      );
      return null;
    } finally {
      setBusy("");
    }
  }
  async function importAction(body: Record<string, unknown>) {
    setBusy(`import:${String(body.action)}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/platform/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Record<string, unknown> & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "데이터 이관을 완료하지 못했습니다.");
      setNotice("데이터 이관 단계가 완료되었습니다.");
      await load();
      return payload;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "데이터 이관을 완료하지 못했습니다.",
      );
      return null;
    } finally {
      setBusy("");
    }
  }

  if (!data)
    return (
      <main className="platform-loading">
        <b className="platform-loading-wordmark talos-wordmark">TALOS PMS</b>
        <h1>멀티호텔 운영 환경을 불러오고 있습니다</h1>
        {error && (
          <>
            <p>{error}</p>
            <button onClick={() => void load()}>다시 시도</button>
          </>
        )}
      </main>
    );
  const current = data.portfolio.find(
    (item) => item.property_id === data.currentPropertyId,
  );
  return (
    <main className="platform-console">
      <header className="platform-header">
        <div className="platform-brand">
          <div>
            <b className="talos-wordmark">TALOS PMS</b>
            <small>CONTROL PLANE</small>
            <span>{data.organizationName}</span>
          </div>
        </div>
        <div>
          <a href="/overview">PMS로 돌아가기</a>
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.replace("/login");
            }}
          >
            로그아웃
          </button>
        </div>
      </header>
      <section className="platform-hero">
        <div>
          <span>ORGANIZATION CONTROL PLANE</span>
          <h1>
            모든 호텔을 한눈에,
            <br />각 데이터는 완전히 격리되게.
          </h1>
          <p>
            호텔 생성, 도메인, 기능 권한, 백업, 연동 작업과 장애 상태를 조직
            단위로 관리합니다.
          </p>
        </div>
        <dl>
          <div>
            <dt>운영 호텔</dt>
            <dd>{data.portfolio.length}</dd>
          </div>
          <div>
            <dt>활성 객실</dt>
            <dd>
              {data.portfolio.reduce(
                (sum, item) => sum + Number(item.active_rooms),
                0,
              )}
            </dd>
          </div>
          <div>
            <dt>대기 작업</dt>
            <dd>
              {data.portfolio.reduce(
                (sum, item) => sum + Number(item.pending_jobs),
                0,
              )}
            </dd>
          </div>
          <div>
            <dt>열린 장애</dt>
            <dd>
              {data.portfolio.reduce(
                (sum, item) => sum + Number(item.open_incidents),
                0,
              )}
            </dd>
          </div>
        </dl>
      </section>
      {data.configuration.platformMfaRequired &&
        data.identity.assuranceLevel !== "aal2" && (
          <section className="platform-alert">
            <b>민감한 설정 변경은 MFA가 필요합니다.</b>
            <p>
              Supabase 계정 보안에서 두 번째 인증 수단을 완료한 뒤 다시 시도해
              주세요. 조회와 호텔 전환은 계속 사용할 수 있습니다.
            </p>
          </section>
        )}
      {(error || notice) && (
        <div
          className={error ? "platform-message error" : "platform-message"}
          role="status"
        >
          {error || notice}
          <button
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            ×
          </button>
        </div>
      )}

      <section className="platform-section">
        <div className="platform-title">
          <div>
            <span>PORTFOLIO</span>
            <h2>호텔 포트폴리오</h2>
            <p>선택한 호텔만 PMS 운영 데이터와 캐시에 연결됩니다.</p>
          </div>
        </div>
        <div className="portfolio-grid">
          {data.portfolio.map((hotel) => (
            <article
              className={
                hotel.property_id === data.currentPropertyId ? "current" : ""
              }
              key={hotel.property_id}
            >
              <div className="hotel-card-head">
                <span>{hotel.property_code}</span>
                <i>{statusLabel(hotel.property_status)}</i>
              </div>
              <h3>{hotel.property_name}</h3>
              <p>
                {hotel.organization_name} · {hotel.plan_code}
              </p>
              <dl>
                <div>
                  <dt>객실</dt>
                  <dd>
                    {hotel.active_rooms}
                    {hotel.room_limit ? ` / ${hotel.room_limit}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>사용자</dt>
                  <dd>
                    {hotel.active_users}
                    {hotel.user_limit ? ` / ${hotel.user_limit}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>대기 작업</dt>
                  <dd>{hotel.pending_jobs}</dd>
                </div>
                <div>
                  <dt>장애</dt>
                  <dd>{hotel.open_incidents}</dd>
                </div>
              </dl>
              <div className="domain-list">
                {(hotel.domains || []).map((domain) => (
                  <span key={domain.id}>
                    <i className={domain.status.toLowerCase()} />
                    {domain.hostname}
                  </span>
                ))}
                {!(hotel.domains || []).length && (
                  <span>연결된 도메인 없음</span>
                )}
              </div>
              <button
                className="platform-primary"
                disabled={
                  hotel.property_id === data.currentPropertyId ||
                  busy === "select_property"
                }
                onClick={async () => {
                  if (
                    await action({
                      action: "select_property",
                      propertyId: hotel.property_id,
                    })
                  )
                    window.location.assign("/overview");
                }}
              >
                {hotel.property_id === data.currentPropertyId
                  ? "현재 운영 중"
                  : "이 호텔 운영하기"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <div className="platform-columns">
        <section className="platform-card">
          <div>
            <span>PROVISIONING</span>
            <h2>새 호텔 생성</h2>
            <p>
              테넌트, 관리자, 기본 회계·요금제·CMS·구독 권한을 하나의
              트랜잭션으로 만듭니다.
            </p>
          </div>
          <ProvisionForm
            organizationId={data.organizationId}
            disabled={!data.configuration.tenantBaseDomain || Boolean(busy)}
            onSubmit={async (value) => {
              await action(value);
            }}
            baseDomain={data.configuration.tenantBaseDomain}
          />
        </section>
        <section className="platform-card">
          <div>
            <span>DOMAIN & RESILIENCE</span>
            <h2>{current?.property_name} 운영 보호</h2>
            <p>
              커스텀 도메인은 DNS 검증 뒤에만 활성화되며, 백업 요청은 비동기
              워커가 처리합니다.
            </p>
          </div>
          <DomainForm
            disabled={Boolean(busy)}
            onSubmit={async (value) => {
              const result = await action(value);
              if (result?.dnsVerification)
                setNotice(
                  `DNS TXT 설정: ${JSON.stringify(result.dnsVerification)}`,
                );
            }}
          />
          <div className="platform-actions">
            <button
              disabled={Boolean(busy)}
              onClick={() =>
                void action({
                  action: "request_backup",
                  backupType: "PROPERTY_EXPORT",
                })
              }
            >
              호텔 데이터 내보내기 백업
            </button>
            <button
              disabled={Boolean(busy)}
              onClick={() =>
                void action({
                  action: "request_backup",
                  backupType: "RESTORE_REHEARSAL",
                })
              }
            >
              복구 리허설 요청
            </button>
          </div>
        </section>
      </div>

      <section className="platform-section">
        <div className="platform-title">
          <div>
            <span>SAFE MIGRATION</span>
            <h2>데이터 이관 센터</h2>
            <p>
              원본 CSV는 저장하지 않고 정규화된 행과 오류만 보관합니다.
              dry-run이 100% 통과한 작업만 원자적으로 반영됩니다.
            </p>
          </div>
        </div>
        <ImportPanel
          rows={data.imports}
          disabled={Boolean(busy)}
          onAction={importAction}
        />
      </section>

      <section className="platform-section">
        <div className="platform-title">
          <div>
            <span>JUST-IN-TIME SUPPORT</span>
            <h2>안전한 지원 접근</h2>
            <p>
              지정한 지원 담당자에게 필요한 화면만, 정해진 시간 동안 허용합니다.
              모든 접근은 티켓과 감사 로그에 연결됩니다.
            </p>
          </div>
        </div>
        <SupportPanel
          rows={data.supportGrants}
          disabled={
            Boolean(busy) ||
            (data.configuration.platformMfaRequired &&
              data.identity.assuranceLevel !== "aal2")
          }
          onAction={action}
        />
      </section>

      <div className="platform-columns">
        <StatusTable
          title="비동기 작업"
          empty="대기 중인 작업이 없습니다."
          rows={data.jobs}
          columns={["job_type", "status", "attempts", "available_at"]}
        />
        <StatusTable
          title="백업·복구"
          empty="백업 실행 기록이 없습니다."
          rows={data.backups}
          columns={["backup_type", "status", "requested_at", "verified_at"]}
        />
        <StatusTable
          title="서비스 장애"
          empty="열린 서비스 장애가 없습니다."
          rows={data.incidents}
          columns={["component", "severity", "status", "started_at"]}
        />
      </div>
      <CompanyFooter />
    </main>
  );
}

function SupportPanel({
  rows,
  disabled,
  onAction,
}: {
  rows: Array<Record<string, unknown>>;
  disabled: boolean;
  onAction: (
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [operatorUserId, setOperatorUserId] = useState("");
  const [renderedAt] = useState(() => Date.now());
  const [operatorEmail, setOperatorEmail] = useState("");
  const [accessMode, setAccessMode] = useState<"READ" | "WRITE">("READ");
  const [piiMode, setPiiMode] = useState<"MASKED" | "FULL">("MASKED");
  const [reason, setReason] = useState("");
  const [ticketReference, setTicketReference] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);
  const [workspaces, setWorkspaces] = useState<PmsWorkspace[]>([
    "overview",
    "frontdesk",
  ]);

  const toggleWorkspace = (workspace: PmsWorkspace) =>
    setWorkspaces((current) =>
      current.includes(workspace)
        ? current.filter((item) => item !== workspace)
        : [...current, workspace],
    );

  return (
    <div className="support-access-grid">
      <form
        className="support-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await onAction({
            action: "create_support_grant",
            operatorUserId,
            operatorEmail,
            accessMode,
            piiMode,
            workspaces,
            reason,
            ticketReference,
            expiresInMinutes,
          });
          if (result) {
            setReason("");
            setTicketReference("");
          }
        }}
      >
        <div className="support-form-fields">
          <label>
            <span>지원 담당자 Auth UUID</span>
            <input
              required
              type="text"
              inputMode="text"
              pattern="[0-9a-fA-F-]{36}"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={operatorUserId}
              onChange={(event) => setOperatorUserId(event.target.value.trim())}
            />
          </label>
          <label>
            <span>지원 담당자 이메일</span>
            <input
              required
              type="email"
              autoComplete="off"
              placeholder="support@example.com"
              value={operatorEmail}
              onChange={(event) => setOperatorEmail(event.target.value.trim())}
            />
          </label>
          <label>
            <span>접근 모드</span>
            <select
              value={accessMode}
              onChange={(event) =>
                setAccessMode(event.target.value as "READ" | "WRITE")
              }
            >
              <option value="READ">조회 전용</option>
              <option value="WRITE">입력·수정</option>
            </select>
          </label>
          <label>
            <span>개인정보 표시</span>
            <select
              value={piiMode}
              onChange={(event) =>
                setPiiMode(event.target.value as "MASKED" | "FULL")
              }
            >
              <option value="MASKED">마스킹</option>
              <option value="FULL">전체 표시</option>
            </select>
          </label>
          <label>
            <span>허용 시간</span>
            <select
              value={expiresInMinutes}
              onChange={(event) =>
                setExpiresInMinutes(Number(event.target.value))
              }
            >
              <option value={30}>30분</option>
              <option value={60}>1시간</option>
              <option value={120}>2시간</option>
              <option value={240}>4시간</option>
              <option value={480}>8시간</option>
            </select>
          </label>
          <label>
            <span>지원 티켓 번호</span>
            <input
              required
              minLength={3}
              maxLength={80}
              placeholder="SUP-2026-001"
              value={ticketReference}
              onChange={(event) => setTicketReference(event.target.value)}
            />
          </label>
          <label className="wide">
            <span>접근 사유</span>
            <textarea
              required
              minLength={10}
              maxLength={1000}
              rows={3}
              placeholder="장애 증상과 지원이 필요한 범위를 구체적으로 입력하세요."
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
        <fieldset>
          <legend>허용할 화면</legend>
          <div className="support-workspaces">
            {PMS_WORKSPACES.map((workspace) => (
              <label key={workspace}>
                <input
                  type="checkbox"
                  checked={workspaces.includes(workspace)}
                  onChange={() => toggleWorkspace(workspace)}
                />
                <span>{WORKSPACE_LABELS[workspace]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          className="platform-primary"
          disabled={disabled || workspaces.length === 0}
        >
          시간 제한 접근 승인
        </button>
        {disabled && (
          <p className="support-disabled-note">
            접근 승인은 MFA 인증 후 사용할 수 있습니다.
          </p>
        )}
      </form>

      <div className="support-grant-list">
        {rows.length === 0 ? (
          <p className="platform-empty">발급된 지원 접근 권한이 없습니다.</p>
        ) : (
          rows.map((row) => {
            const isActive =
              !row.revoked_at &&
              Date.parse(String(row.expires_at)) > renderedAt;
            return (
              <article key={String(row.id)}>
                <div className="support-grant-head">
                  <div>
                    <b>{String(row.operator_email)}</b>
                    <span>{String(row.ticket_reference)}</span>
                  </div>
                  <i className={isActive ? "active" : "closed"}>
                    {row.revoked_at ? "철회됨" : isActive ? "활성" : "만료됨"}
                  </i>
                </div>
                <dl>
                  <div>
                    <dt>권한</dt>
                    <dd>
                      {statusLabel(row.access_mode)} ·{" "}
                      {statusLabel(row.pii_mode)}
                    </dd>
                  </div>
                  <div>
                    <dt>만료</dt>
                    <dd>
                      {new Date(String(row.expires_at)).toLocaleString("ko-KR")}
                    </dd>
                  </div>
                </dl>
                <p>{String(row.reason)}</p>
                {isActive && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void onAction({
                        action: "revoke_support_grant",
                        grantId: row.id,
                      })
                    }
                  >
                    즉시 접근 철회
                  </button>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function ProvisionForm({
  organizationId,
  baseDomain,
  disabled,
  onSubmit,
}: {
  organizationId: string;
  baseDomain: string | null;
  disabled: boolean;
  onSubmit: (value: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: "",
    code: "",
    slug: "",
    businessDate: dateInSeoul(),
    planCode: "STANDARD",
  });
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="platform-form"
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        await onSubmit({
          action: "provision_property",
          organizationId,
          ...form,
          timezone: "Asia/Seoul",
          currency: "KRW",
        });
      }}
    >
      <label>
        <span>호텔명</span>
        <input
          required
          minLength={2}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </label>
      <label>
        <span>호텔 코드</span>
        <input
          required
          minLength={2}
          maxLength={16}
          value={form.code}
          onChange={(e) => set("code", e.target.value.toUpperCase())}
        />
      </label>
      <label className="wide">
        <span>사이트 주소</span>
        <div className="domain-input">
          <input
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            value={form.slug}
            onChange={(e) =>
              set(
                "slug",
                e.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, ""),
              )
            }
          />
          <b>.{baseDomain || "도메인 설정 필요"}</b>
        </div>
      </label>
      <label>
        <span>영업 시작일</span>
        <input
          type="date"
          required
          value={form.businessDate}
          onChange={(e) => set("businessDate", e.target.value)}
        />
      </label>
      <label>
        <span>플랜</span>
        <select
          value={form.planCode}
          onChange={(e) => set("planCode", e.target.value)}
        >
          <option value="STARTER">Starter</option>
          <option value="STANDARD">Standard</option>
          <option value="PRO">Pro</option>
        </select>
      </label>
      <button className="platform-primary wide" disabled={disabled}>
        호텔 환경 생성
      </button>
    </form>
  );
}

function DomainForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (value: Record<string, unknown>) => Promise<void>;
}) {
  const [hostname, setHostname] = useState("");
  return (
    <form
      className="platform-domain-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit({ action: "add_domain", hostname, kind: "CUSTOM" });
        setHostname("");
      }}
    >
      <label>
        <span>커스텀 도메인</span>
        <input
          type="text"
          required
          placeholder="hotel.example.com"
          value={hostname}
          onChange={(e) => setHostname(e.target.value.toLowerCase())}
        />
      </label>
      <button disabled={disabled}>DNS 검증 시작</button>
    </form>
  );
}

function ImportPanel({
  rows,
  disabled,
  onAction,
}: {
  rows: Array<Record<string, unknown>>;
  disabled: boolean;
  onAction: (
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [kind, setKind] = useState("ROOM_TYPES"),
    [file, setFile] = useState<File | null>(null);
  return (
    <div className="import-panel">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!file) return;
          const csv = await file.text();
          await onAction({
            action: "dry_run",
            kind,
            sourceName: file.name,
            csv,
          });
          setFile(null);
        }}
      >
        <label>
          <span>데이터 종류</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="ROOM_TYPES">1. 객실 타입</option>
            <option value="ROOMS">2. 객실</option>
            <option value="GUESTS">3. 고객</option>
            <option value="RESERVATIONS">4. 예약</option>
          </select>
        </label>
        <label>
          <span>CSV 파일 · 최대 2MB / 2,000행</span>
          <input
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <button className="platform-primary" disabled={disabled || !file}>
          Dry-run 검증
        </button>
      </form>
      <div className="import-history">
        {rows.length === 0 ? (
          <p className="platform-empty">아직 데이터 이관 작업이 없습니다.</p>
        ) : (
          rows.map((row) => (
            <article key={String(row.id)}>
              <div>
                <b>
                  {statusLabel(row.kind)} · {statusLabel(row.mode)}
                </b>
                <span>
                  {String(row.source_name)} · 전체 {String(row.row_count)} /
                  정상 {String(row.valid_count)} / 오류{" "}
                  {String(row.error_count)}
                </span>
              </div>
              <i className={String(row.status).toLowerCase()}>
                {statusLabel(row.status)}
              </i>
              <div>
                {row.mode === "DRY_RUN" &&
                  row.status === "VALIDATED" &&
                  Number(row.error_count) === 0 && (
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void onAction({ action: "commit", jobId: row.id,expectedKind:row.kind })
                      }
                    >
                      원자적 반영
                    </button>
                  )}
                {row.mode === "COMMIT" && row.status === "COMPLETED" && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void onAction({ action: "rollback", jobId: row.id,expectedKind:row.kind })
                    }
                  >
                    안전 롤백
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function StatusTable({
  title,
  empty,
  rows,
  columns,
}: {
  title: string;
  empty: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
}) {
  return (
    <section className="platform-card platform-table">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="platform-empty">{empty}</p>
      ) : (
        <div>
          {rows.slice(0, 8).map((row, index) => (
            <article key={String(row.id || index)}>
              <b>{statusLabel(row[columns[0]])}</b>
              <span>
                {columns
                  .slice(1)
                  .map((column) => statusLabel(row[column]))
                  .join(" · ")}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
