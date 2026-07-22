"use client";

/** Dedicated HotelStory-style daily operation, banquet, import, and member screens. */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { usePmsActions } from "./pms-action-context";
import { formatMoney } from "../lib/format";
import { useDebouncedValue } from "./use-debounced-value";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error || "데이터를 불러오지 못했습니다.");
  return body;
}
const isoToday = () => new Date().toISOString().slice(0, 10);
const statusLabel: Record<string, string> = {
  DUE_IN: "도착 예정",
  IN_HOUSE: "투숙 중",
  CHECKED_OUT: "체크아웃",
  TENTATIVE: "가예약",
  CONFIRMED: "확정",
  COMPLETED: "완료",
  CANCELLED: "취소",
};
const memberTypeLabel: Record<string, string> = {
  HOTEL: "호텔",
  WEBSITE: "홈페이지",
  BOTH: "통합",
};
const administratorTypeLabel: Record<string, string> = {
  NONE: "일반",
  COMPANY: "기업 관리자",
  WEBSITE: "홈페이지 관리자",
};

export function HotelStoryQuickLinks({
  workspace,
}: {
  workspace: "frontdesk" | "groups" | "users";
}) {
  const items =
    workspace === "frontdesk"
      ? [
          [
            "/frontdesk/checkin",
            "당일 체크인",
            "도착 예정·미배정·ETA를 한 화면에서 처리",
          ],
          [
            "/frontdesk/checkout",
            "당일 체크아웃",
            "출발 예정과 미정산 잔액을 우선 처리",
          ],
          [
            "/frontdesk/occupancy",
            "객실 점유 현황",
            "판매 상품별 18일 룸 타임라인",
          ],
          [
            "/frontdesk/imports",
            "예약 일괄 등록",
            "Excel용 CSV 검증·반영·롤백",
          ],
        ]
      : workspace === "groups"
        ? [
            [
              "/groups/banquet",
              "연회 예약 캘린더",
              "연회장·행사·시간 충돌을 월간 관리",
            ],
          ]
        : [
            [
              "/users/members",
              "호텔·홈페이지 회원",
              "회원 등급·상태·로그인 비밀번호 관리",
            ],
          ];
  return (
    <nav
      className="hs-quick-links"
      aria-label="HotelStory 벤치마킹 업무 바로가기"
    >
      {items.map(([href, title, description]) => (
        <Link href={href} key={href}>
          <span>{title}</span>
          <small>{description}</small>
          <b aria-hidden="true">→</b>
        </Link>
      ))}
    </nav>
  );
}

type StayReservation = {
  id: string;
  confirmation_no: string;
  arrival_date: string;
  departure_date: string;
  status: string;
  source: string;
  rate_plan: string;
  room_id: string | null;
  room_type_id: string;
  eta: string | null;
  version: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  room_number: string | null;
  room_type_code: string;
  room_type_name: string;
  balance: number;
};
type StayData = {
  mode: string;
  businessDate: string;
  selectedDate: string;
  dates: string[];
  reservations: StayReservation[];
  rooms: Array<{
    id: string;
    number: string;
    floor: number;
    room_type_id: string;
    front_desk_status: string;
    housekeeping_status: string;
    room_type_code: string;
    room_type_name: string;
  }>;
  roomTypes: Array<{ id: string; code: string; name: string }>;
  ratePlans: Array<{ id: string; code: string; name: string }>;
  sources: string[];
};

export function StayOperationsCenter({
  mode,
  businessDate,
}: {
  mode: "checkin" | "checkout" | "occupancy";
  businessDate: string;
}) {
  const router = useRouter(),
    { busy, act } = usePmsActions();
  const [date, setDate] = useState(businessDate),
    [q, setQ] = useState(""),
    [source, setSource] = useState(""),
    [roomTypeId, setRoomTypeId] = useState(""),
    [ratePlan, setRatePlan] = useState("");
  const [debouncedQ, flushQ] = useDebouncedValue(q);
  const params = new URLSearchParams({ view: "stay_operations", mode, date });
  if (debouncedQ) params.set("q", debouncedQ);
  if (source) params.set("source", source);
  if (roomTypeId) params.set("roomTypeId", roomTypeId);
  if (ratePlan) params.set("ratePlan", ratePlan);
  const query = useQuery({
    queryKey: [
      "pms",
      "stay-operations",
      mode,
      date,
      debouncedQ,
      source,
      roomTypeId,
      ratePlan,
    ],
    queryFn: ({ signal }) => json<StayData>(`/api/pms?${params}`, { signal }),
    staleTime: 20_000,
  });
  const data = query.data;
  async function transition(
    action: "check_in" | "check_out",
    reservationId: string,
  ) {
    if (await act(action, { reservationId })) await query.refetch();
  }
  return (
    <section className="hs-workspace" aria-busy={query.isFetching}>
      <div className="hs-page-head">
        <div>
          <p>HOTELSTORY DAILY OPERATION</p>
          <h2>
            {mode === "checkin"
              ? "당일 체크인"
              : mode === "checkout"
                ? "당일 체크아웃"
                : "객실 점유 현황"}
          </h2>
          <span>
            {mode === "occupancy"
              ? "선택일부터 18일간 객실별 예약 흐름을 비교합니다."
              : "오늘 처리해야 할 고객만 우선순위대로 모았습니다."}
          </span>
        </div>
        <HotelStoryQuickLinks workspace="frontdesk" />
      </div>
      <div className="hs-filter-bar">
        <label>
          <span>기준일</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label className="grow">
          <span>통합 검색</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="예약번호·고객·전화·객실"
          />
        </label>
        <label>
          <span>판매 경로</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">전체</option>
            {data?.sources.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>객실 타입</span>
          <select
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
          >
            <option value="">전체</option>
            {data?.roomTypes.map((item) => (
              <option value={item.id} key={item.id}>
                {item.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>판매 상품</span>
          <select
            value={ratePlan}
            onChange={(event) => setRatePlan(event.target.value)}
          >
            <option value="">전체</option>
            {data?.ratePlans.map((item) => (
              <option value={item.code} key={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => (q === debouncedQ ? void query.refetch() : flushQ())}
        >
          조회
        </button>
      </div>
      {query.error && (
        <p className="hs-error" role="alert">
          {query.error.message}
        </p>
      )}
      {mode !== "occupancy" && (
        <div className="hs-table-wrap">
          <table className="hs-data-table">
            <thead>
              <tr>
                <th>예약/고객</th>
                <th>객실</th>
                <th>일정</th>
                <th>판매 정보</th>
                <th>정산</th>
                <th>상태/처리</th>
              </tr>
            </thead>
            <tbody>
              {data?.reservations.map((row) => (
                <tr
                  key={row.id}
                  onDoubleClick={() =>
                    router.push(
                      `/frontdesk?focus=${encodeURIComponent(row.id)}`,
                    )
                  }
                >
                  <td>
                    <button
                      className="hs-row-link"
                      onClick={() =>
                        router.push(
                          `/frontdesk?focus=${encodeURIComponent(row.id)}`,
                        )
                      }
                    >
                      <b>
                        {row.first_name} {row.last_name}
                      </b>
                      <small>
                        {row.confirmation_no} · {row.phone || "전화 없음"}
                      </small>
                    </button>
                  </td>
                  <td>
                    <b>{row.room_number || "미배정"}</b>
                    <small>
                      {row.room_type_code} · {row.room_type_name}
                    </small>
                  </td>
                  <td>
                    <b>
                      {row.arrival_date} → {row.departure_date}
                    </b>
                    <small>
                      {row.eta
                        ? `ETA ${String(row.eta).slice(0, 5)}`
                        : "ETA 미입력"}
                    </small>
                  </td>
                  <td>
                    <b>{row.source}</b>
                    <small>{row.rate_plan}</small>
                  </td>
                  <td className={Number(row.balance) !== 0 ? "due" : "clear"}>
                    {formatMoney(Number(row.balance))}
                  </td>
                  <td>
                    <span className={`hs-state ${row.status.toLowerCase()}`}>
                      {statusLabel[row.status] || row.status}
                    </span>
                    {mode === "checkin" && (
                      <button
                        disabled={Boolean(busy) || !row.room_number}
                        onClick={() => void transition("check_in", row.id)}
                      >
                        {row.room_number ? "체크인" : "객실 배정 필요"}
                      </button>
                    )}
                    {mode === "checkout" && (
                      <button
                        disabled={Boolean(busy) || Number(row.balance) !== 0}
                        onClick={() => void transition("check_out", row.id)}
                      >
                        {Number(row.balance) === 0 ? "체크아웃" : "정산 필요"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!query.isLoading && data?.reservations.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="hs-empty">
                      <b>조건에 맞는 당일 업무가 없습니다.</b>
                      <span>기준일 또는 필터를 변경해 보세요.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {mode === "occupancy" && (
        <div className="hs-timeline-wrap">
          <div
            className="hs-timeline"
            style={{
              gridTemplateColumns: `150px repeat(${data?.dates.length || 18},minmax(76px,1fr))`,
            }}
          >
            <div className="corner">객실</div>
            {data?.dates.map((item) => (
              <div className="date" key={item}>
                <b>{item.slice(8)}</b>
                <small>
                  {new Intl.DateTimeFormat("ko-KR", {
                    weekday: "short",
                  }).format(new Date(`${item}T00:00:00Z`))}
                </small>
              </div>
            ))}
            {data?.rooms.map((room) => (
              <div
                className="timeline-row"
                style={{ display: "contents" }}
                key={room.id}
              >
                <div className="room">
                  <b>{room.number}</b>
                  <small>
                    {room.room_type_code} · {room.housekeeping_status}
                  </small>
                </div>
                {data.dates.map((day) => {
                  const reservation = (data.reservations || []).find(
                    (item) =>
                      item.room_id === room.id &&
                      item.arrival_date <= day &&
                      item.departure_date > day,
                  );
                  return (
                    <button
                      key={day}
                      className={reservation ? "occupied" : "vacant"}
                      title={
                        reservation
                          ? `${reservation.first_name} ${reservation.last_name} · ${reservation.rate_plan}`
                          : "공실"
                      }
                      onClick={() =>
                        reservation &&
                        router.push(
                          `/frontdesk?focus=${encodeURIComponent(reservation.id)}`,
                        )
                      }
                    >
                      {reservation ? (
                        <>
                          <b>
                            {day === reservation.arrival_date
                              ? reservation.last_name
                              : "●"}
                          </b>
                          <small>{reservation.rate_plan}</small>
                        </>
                      ) : (
                        <span>—</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type Venue = {
  id: string;
  code: string;
  name: string;
  capacity: number;
  location: string;
  amenities: string[];
  active: boolean;
  version: number;
};
type BanquetReservation = {
  id: string;
  venue_id: string;
  event_date: string;
  start_time: string;
  end_time: string;
  event_name: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  attendees: number;
  fee: number;
  status: string;
  notes: string;
  version: number;
  venue_code: string;
  venue_name: string;
};
type BanquetData = {
  month: string;
  venues: Venue[];
  reservations: BanquetReservation[];
};

export function BanquetManager() {
  const { busy, act } = usePmsActions(),
    [month, setMonth] = useState(isoToday().slice(0, 7)),
    [q, setQ] = useState(""),
    [venueId, setVenueId] = useState(""),
    [status, setStatus] = useState(""),
    [selectedDate, setSelectedDate] = useState(isoToday()),
    [editing, setEditing] = useState<BanquetReservation | null | "new">(null),
    [venueEditor, setVenueEditor] = useState<Venue | null | "new">(null);
  const [debouncedQ] = useDebouncedValue(q);
  const params = new URLSearchParams({ view: "banquet", month });
  if (debouncedQ) params.set("q", debouncedQ);
  if (venueId) params.set("venueId", venueId);
  if (status) params.set("status", status);
  const query = useQuery({
    queryKey: ["pms", "banquet", month, debouncedQ, venueId, status],
    queryFn: ({ signal }) =>
      json<BanquetData>(`/api/pms?${params}`, { signal }),
    staleTime: 20_000,
  });
  const cells = useMemo(() => {
    const first = new Date(`${month}-01T00:00:00Z`),
      start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + index);
      return day.toISOString().slice(0, 10);
    });
  }, [month]);
  async function submitVenue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const current = venueEditor === "new" ? null : venueEditor;
    if (
      await act("upsert_banquet_venue", {
        ...form,
        venueId: current?.id || "",
        expectedVersion: String(current?.version || ""),
      } as Record<string, string>)
    ) {
      setVenueEditor(null);
      await query.refetch();
    }
  }
  async function submitReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const current = editing === "new" ? null : editing;
    if (
      await act("upsert_banquet_reservation", {
        ...form,
        banquetReservationId: current?.id || "",
        expectedVersion: String(current?.version || ""),
      } as Record<string, string>)
    ) {
      setEditing(null);
      await query.refetch();
    }
  }
  return (
    <section className="hs-workspace">
      <div className="hs-page-head">
        <div>
          <p>HOTELSTORY BANQUET</p>
          <h2>연회 예약 캘린더</h2>
          <span>
            날짜를 누르면 행사를 만들고, 시간 중복은 데이터베이스가 차단합니다.
          </span>
        </div>
        <div className="hs-head-actions">
          <button className="secondary" onClick={() => setVenueEditor("new")}>
            연회장 설정
          </button>
          <button
            className="primary"
            onClick={() => {
              setSelectedDate(`${month}-01`);
              setEditing("new");
            }}
          >
            ＋ 연회 예약
          </button>
        </div>
      </div>
      <div className="hs-filter-bar">
        <label>
          <span>조회 월</span>
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
        <label className="grow">
          <span>행사 검색</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="행사명·담당자·전화·연회장"
          />
        </label>
        <label>
          <span>연회장</span>
          <select
            value={venueId}
            onChange={(event) => setVenueId(event.target.value)}
          >
            <option value="">전체</option>
            {query.data?.venues.map((item) => (
              <option value={item.id} key={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>상태</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">전체</option>
            {["TENTATIVE", "CONFIRMED", "COMPLETED", "CANCELLED"].map(
              (item) => (
                <option value={item} key={item}>
                  {statusLabel[item]}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {query.error && <p className="hs-error">{query.error.message}</p>}
      <div
        className="hs-calendar-scroll"
        role="region"
        aria-label="연회 예약 월간 달력"
        tabIndex={0}
      >
        <div className="hs-month-weekdays">
          {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
            <b key={day}>{day}</b>
          ))}
        </div>
        <div className="hs-month-grid">
          {cells.map((day) => {
            const events =
                query.data?.reservations.filter(
                  (item) => item.event_date === day,
                ) || [],
              outside = day.slice(0, 7) !== month;
            return (
              <button
                type="button"
                className={outside ? "outside" : ""}
                key={day}
                onClick={() => {
                  setSelectedDate(day);
                  setEditing("new");
                }}
              >
                <strong>{Number(day.slice(8))}</strong>
                <span>
                  {events.map((item) => (
                    <i
                      className={item.status.toLowerCase()}
                      key={item.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditing(item);
                      }}
                    >
                      <b>
                        {String(item.start_time).slice(0, 5)} {item.event_name}
                      </b>
                      <small>
                        {item.venue_code} · {item.attendees}명
                      </small>
                    </i>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {venueEditor && (
        <div className="modal-backdrop">
          <form className="hs-modal" onSubmit={submitVenue}>
            <div className="hs-modal-head">
              <div>
                <p>VENUE MASTER</p>
                <h3>{venueEditor === "new" ? "연회장 추가" : "연회장 수정"}</h3>
              </div>
              <button type="button" onClick={() => setVenueEditor(null)}>
                ×
              </button>
            </div>
            {venueEditor === "new" ? null : (
              <input
                type="hidden"
                name="expectedVersion"
                value={venueEditor.version}
              />
            )}
            <div className="hs-form-grid">
              <label>
                <span>코드</span>
                <input
                  name="code"
                  required
                  defaultValue={venueEditor === "new" ? "" : venueEditor.code}
                />
              </label>
              <label>
                <span>연회장명</span>
                <input
                  name="name"
                  required
                  defaultValue={venueEditor === "new" ? "" : venueEditor.name}
                />
              </label>
              <label>
                <span>수용 인원</span>
                <input
                  name="capacity"
                  type="number"
                  min="1"
                  required
                  defaultValue={
                    venueEditor === "new" ? 50 : venueEditor.capacity
                  }
                />
              </label>
              <label>
                <span>위치</span>
                <input
                  name="location"
                  defaultValue={
                    venueEditor === "new" ? "" : venueEditor.location
                  }
                />
              </label>
              <label className="wide">
                <span>시설·비품(쉼표 구분)</span>
                <input
                  name="amenities"
                  defaultValue={
                    venueEditor === "new"
                      ? ""
                      : venueEditor.amenities.join(", ")
                  }
                />
              </label>
              <label className="check">
                <input
                  name="active"
                  type="checkbox"
                  value="true"
                  defaultChecked={venueEditor === "new" || venueEditor.active}
                />
                <span>사용 중</span>
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setVenueEditor(null)}
              >
                닫기
              </button>
              <button className="primary" disabled={Boolean(busy)}>
                저장
              </button>
            </div>
          </form>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <form className="hs-modal banquet" onSubmit={submitReservation}>
            <div className="hs-modal-head">
              <div>
                <p>BANQUET RESERVATION</p>
                <h3>
                  {editing === "new" ? "연회 예약 등록" : "연회 예약 수정"}
                </h3>
              </div>
              <button type="button" onClick={() => setEditing(null)}>
                ×
              </button>
            </div>
            <div className="hs-form-grid">
              <label>
                <span>행사일</span>
                <input
                  name="eventDate"
                  type="date"
                  required
                  defaultValue={
                    editing === "new" ? selectedDate : editing.event_date
                  }
                />
              </label>
              <label>
                <span>연회장</span>
                <select
                  name="venueId"
                  required
                  defaultValue={
                    editing === "new"
                      ? query.data?.venues.find((item) => item.active)?.id
                      : editing.venue_id
                  }
                >
                  {query.data?.venues
                    .filter(
                      (item) =>
                        item.active ||
                        item.id === (editing !== "new" ? editing.venue_id : ""),
                    )
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.code} · {item.name} ({item.capacity}명)
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>시작</span>
                <input
                  name="startTime"
                  type="time"
                  required
                  defaultValue={
                    editing === "new"
                      ? "10:00"
                      : String(editing.start_time).slice(0, 5)
                  }
                />
              </label>
              <label>
                <span>종료</span>
                <input
                  name="endTime"
                  type="time"
                  required
                  defaultValue={
                    editing === "new"
                      ? "12:00"
                      : String(editing.end_time).slice(0, 5)
                  }
                />
              </label>
              <label className="wide">
                <span>행사명</span>
                <input
                  name="eventName"
                  required
                  defaultValue={editing === "new" ? "" : editing.event_name}
                />
              </label>
              <label>
                <span>담당자</span>
                <input
                  name="contactName"
                  required
                  defaultValue={editing === "new" ? "" : editing.contact_name}
                />
              </label>
              <label>
                <span>연락처</span>
                <input
                  name="contactPhone"
                  defaultValue={editing === "new" ? "" : editing.contact_phone}
                />
              </label>
              <label>
                <span>이메일</span>
                <input
                  name="contactEmail"
                  type="email"
                  defaultValue={
                    editing === "new" ? "" : editing.contact_email || ""
                  }
                />
              </label>
              <label>
                <span>예상 인원</span>
                <input
                  name="attendees"
                  type="number"
                  min="1"
                  required
                  defaultValue={editing === "new" ? 20 : editing.attendees}
                />
              </label>
              <label>
                <span>행사 금액</span>
                <input
                  name="fee"
                  type="number"
                  min="0"
                  required
                  defaultValue={editing === "new" ? 0 : editing.fee}
                />
              </label>
              <label>
                <span>상태</span>
                <select
                  name="status"
                  defaultValue={
                    editing === "new" ? "TENTATIVE" : editing.status
                  }
                >
                  {["TENTATIVE", "CONFIRMED", "COMPLETED", "CANCELLED"].map(
                    (item) => (
                      <option value={item} key={item}>
                        {statusLabel[item]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="wide">
                <span>운영 메모</span>
                <textarea
                  name="notes"
                  defaultValue={editing === "new" ? "" : editing.notes}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(null)}
              >
                닫기
              </button>
              <button className="primary" disabled={Boolean(busy)}>
                충돌 확인 후 저장
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

type Member = {
  id: string;
  member_no: string;
  login_id: string | null;
  member_type: string;
  name: string;
  phone: string;
  email: string | null;
  company: string;
  grade: string;
  administrator_type: string;
  active: boolean;
  joined_date: string;
  password_ready: boolean;
  version: number;
};
type MemberData = { members: Member[] };
export function HotelMemberManager() {
  const { busy, act } = usePmsActions(),
    [q, setQ] = useState(""),
    [type, setType] = useState(""),
    [active, setActive] = useState("ALL"),
    [editing, setEditing] = useState<Member | null | "new">(null),
    [passwordMember, setPasswordMember] = useState<Member | null>(null);
  const [debouncedQ, flushQ] = useDebouncedValue(q);
  const params = new URLSearchParams({
    view: "hotel_members",
    q: debouncedQ,
    type,
    active,
  });
  const query = useQuery({
    queryKey: ["pms", "hotel-members", debouncedQ, type, active],
    queryFn: ({ signal }) => json<MemberData>(`/api/pms?${params}`, { signal }),
    staleTime: 20_000,
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const current = editing === "new" ? null : editing;
    if (
      await act("upsert_hotel_member", {
        ...form,
        memberId: current?.id || "",
        expectedVersion: String(current?.version || ""),
        active: String(form.active === "true"),
      } as Record<string, string>)
    ) {
      setEditing(null);
      await query.refetch();
    }
  }
  return (
    <section className="hs-workspace">
      <div className="hs-page-head">
        <div>
          <p>HOTEL & WEBSITE MEMBER</p>
          <h2>호텔·홈페이지 회원</h2>
          <span>
            개인정보는 호텔 단위로 격리되며 비밀번호 원문은 저장하지 않습니다.
          </span>
        </div>
        <button className="primary" onClick={() => setEditing("new")}>
          ＋ 회원 등록
        </button>
      </div>
      <div className="hs-filter-bar">
        <label className="grow">
          <span>회원 검색</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="이름·전화·ID·회사·회원코드"
          />
        </label>
        <label>
          <span>회원 구분</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="">전체</option>
            <option value="HOTEL">호텔</option>
            <option value="WEBSITE">홈페이지</option>
            <option value="BOTH">통합</option>
          </select>
        </label>
        <label>
          <span>활성 상태</span>
          <select
            value={active}
            onChange={(event) => setActive(event.target.value)}
          >
            <option value="ALL">전체</option>
            <option value="ACTIVE">활성</option>
            <option value="INACTIVE">비활성</option>
          </select>
        </label>
        <button
          className="secondary"
          onClick={() => (q === debouncedQ ? void query.refetch() : flushQ())}
        >
          조회
        </button>
      </div>
      {query.error && <p className="hs-error">{query.error.message}</p>}
      <div className="hs-table-wrap">
        <table className="hs-data-table">
          <thead>
            <tr>
              <th>회원</th>
              <th>연락처/회사</th>
              <th>구분·등급</th>
              <th>가입일</th>
              <th>계정</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.members.map((member) => (
              <tr key={member.id}>
                <td>
                  <b>{member.name}</b>
                  <small>
                    {member.member_no} · {member.login_id || "로그인 ID 없음"}
                  </small>
                </td>
                <td>
                  <b>{member.phone || "전화 없음"}</b>
                  <small>
                    {member.email || "이메일 없음"} · {member.company || "개인"}
                  </small>
                </td>
                <td>
                  <b>
                    {memberTypeLabel[member.member_type] || member.member_type}{" "}
                    · {member.grade}
                  </b>
                  <small>
                    관리 유형{" "}
                    {administratorTypeLabel[member.administrator_type] ||
                      member.administrator_type}
                  </small>
                </td>
                <td>{member.joined_date}</td>
                <td>
                  <span
                    className={`hs-state ${member.active ? "confirmed" : "cancelled"}`}
                  >
                    {member.active ? "활성" : "중지"}
                  </span>
                  <small>
                    {member.password_ready
                      ? "비밀번호 설정됨"
                      : "비밀번호 미설정"}
                  </small>
                </td>
                <td className="hs-inline-actions">
                  <button
                    className="secondary"
                    onClick={() => setEditing(member)}
                  >
                    수정
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setPasswordMember(member)}
                  >
                    비밀번호
                  </button>
                  <button
                    className="secondary"
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      if (
                        await act("set_hotel_member_active", {
                          memberId: member.id,
                          active: String(!member.active),
                          expectedVersion: String(member.version),
                        })
                      )
                        await query.refetch();
                    }}
                  >
                    {member.active ? "중지" : "활성"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <div className="modal-backdrop">
          <form className="hs-modal" onSubmit={submit}>
            <div className="hs-modal-head">
              <div>
                <p>MEMBER MASTER</p>
                <h3>{editing === "new" ? "회원 등록" : "회원 수정"}</h3>
              </div>
              <button type="button" onClick={() => setEditing(null)}>
                ×
              </button>
            </div>
            <div className="hs-form-grid">
              <label>
                <span>회원 코드</span>
                <input
                  name="memberNo"
                  required
                  defaultValue={editing === "new" ? "" : editing.member_no}
                />
              </label>
              <label>
                <span>로그인 ID</span>
                <input
                  name="loginId"
                  minLength={4}
                  defaultValue={editing === "new" ? "" : editing.login_id || ""}
                />
              </label>
              <label>
                <span>회원명</span>
                <input
                  name="name"
                  required
                  defaultValue={editing === "new" ? "" : editing.name}
                />
              </label>
              <label>
                <span>전화</span>
                <input
                  name="phone"
                  defaultValue={editing === "new" ? "" : editing.phone}
                />
              </label>
              <label>
                <span>이메일</span>
                <input
                  name="email"
                  type="email"
                  defaultValue={editing === "new" ? "" : editing.email || ""}
                />
              </label>
              <label>
                <span>회사</span>
                <input
                  name="company"
                  defaultValue={editing === "new" ? "" : editing.company}
                />
              </label>
              <label>
                <span>회원 구분</span>
                <select
                  name="memberType"
                  defaultValue={
                    editing === "new" ? "HOTEL" : editing.member_type
                  }
                >
                  <option value="HOTEL">호텔</option>
                  <option value="WEBSITE">홈페이지</option>
                  <option value="BOTH">통합</option>
                </select>
              </label>
              <label>
                <span>등급</span>
                <input
                  name="grade"
                  required
                  defaultValue={editing === "new" ? "GENERAL" : editing.grade}
                />
              </label>
              <label>
                <span>관리 유형</span>
                <select
                  name="administratorType"
                  defaultValue={
                    editing === "new" ? "NONE" : editing.administrator_type
                  }
                >
                  <option value="NONE">일반</option>
                  <option value="COMPANY">기업 관리자</option>
                  <option value="WEBSITE">홈페이지 관리자</option>
                </select>
              </label>
              <label>
                <span>가입일</span>
                <input
                  name="joinedDate"
                  type="date"
                  required
                  defaultValue={
                    editing === "new" ? isoToday() : editing.joined_date
                  }
                />
              </label>
              {editing === "new" && (
                <label className="wide">
                  <span>초기 비밀번호(선택)</span>
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="12자·문자 종류 3종 이상"
                  />
                </label>
              )}
              <label className="check">
                <input
                  name="active"
                  type="checkbox"
                  value="true"
                  defaultChecked={editing === "new" || editing.active}
                />
                <span>활성 회원</span>
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(null)}
              >
                닫기
              </button>
              <button className="primary" disabled={Boolean(busy)}>
                저장
              </button>
            </div>
          </form>
        </div>
      )}
      {passwordMember && (
        <div className="modal-backdrop">
          <form
            className="hs-modal compact"
            onSubmit={async (event) => {
              event.preventDefault();
              const password = String(
                new FormData(event.currentTarget).get("password") || "",
              );
              if (
                await act("reset_hotel_member_password", {
                  memberId: passwordMember.id,
                  password,
                  expectedVersion: String(passwordMember.version),
                })
              ) {
                setPasswordMember(null);
                await query.refetch();
              }
            }}
          >
            <div className="hs-modal-head">
              <div>
                <p>{passwordMember.member_no}</p>
                <h3>{passwordMember.name} 비밀번호 변경</h3>
              </div>
              <button type="button" onClick={() => setPasswordMember(null)}>
                ×
              </button>
            </div>
            <label className="hs-single-field">
              <span>새 비밀번호</span>
              <input
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
              <small>영문 대·소문자, 숫자, 특수문자 중 3종 이상</small>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setPasswordMember(null)}
              >
                닫기
              </button>
              <button className="primary">안전하게 변경</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

type ImportJob = {
  id: string;
  mode: string;
  status: string;
  source_name: string;
  row_count: number;
  valid_count: number;
  error_count: number;
  summary: { sampleErrors?: Array<{ rowNumber: number; errors: string[] }> };
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
};
export function ReservationImportCenter() {
  const [csv, setCsv] = useState(""),
    [sourceName, setSourceName] = useState(""),
    [message, setMessage] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const query = useQuery({
    queryKey: ["pms", "reservation-imports"],
    queryFn: () => json<{ jobs: ImportJob[] }>("/api/pms/reservation-imports"),
    staleTime: 10_000,
  });
  const dryRun = query.data?.jobs.find(
    (job) => job.mode === "DRY_RUN" && job.status === "VALIDATED",
  );
  async function command(body: Record<string, string>) {
    setSubmitting(true);
    setMessage("");
    try {
      const result = await json<{
        ok: boolean;
        job?: ImportJob;
        jobId?: string;
        duplicate?: boolean;
        replayed?: boolean;
      }>("/api/pms/reservation-imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMessage(
        body.action === "dry_run"
          ? result.duplicate
            ? "같은 파일을 이미 검증했습니다."
            : "검증을 완료했습니다. 오류가 0건인지 확인하세요."
          : body.action === "commit"
            ? result.replayed
              ? "이미 반영된 파일입니다."
              : "예약을 원자적으로 반영했습니다."
            : "가져오기 작업을 롤백했습니다.",
      );
      await query.refetch();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "작업을 완료하지 못했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  function template() {
    const content =
      "\ufeffexternal_id,confirmation_no,guest_external_id,guest_first_name,guest_last_name,guest_email,guest_phone,room_type_code,arrival_date,departure_date,adults,children,source,rate_plan,nightly_rate,eta,notes\nRES-001,HS-2026-0001,GUEST-001,길동,홍,gildong@example.com,010-0000-0000,STD,2026-07-22,2026-07-24,2,0,HotelStory,BAR,120000,15:00,CSV 일괄 등록\n";
    const url = URL.createObjectURL(
        new Blob([content], { type: "text/csv;charset=utf-8" }),
      ),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "talos-reservation-import-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="hs-workspace">
      <div className="hs-page-head">
        <div>
          <p>RESERVATION EXCEL IMPORT</p>
          <h2>예약 일괄 등록</h2>
          <span>
            Excel에서 CSV UTF-8로 저장한 뒤, 검증 결과를 확인하고 한 번에
            반영합니다.
          </span>
        </div>
        <button className="secondary" onClick={template}>
          양식 내려받기
        </button>
      </div>
      <div className="hs-import-layout">
        <article className="hs-import-card">
          <h3>1. 파일 선택</h3>
          <p>최대 2,000행·2MB. 동일 파일은 해시로 중복 반영되지 않습니다.</p>
          <label className="hs-file-drop">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setSourceName(file.name);
                setCsv(await file.text());
              }}
            />
            <b>{sourceName || "CSV 파일을 선택하거나 끌어 놓으세요"}</b>
            <span>
              {csv
                ? `${csv.split(/\r?\n/u).length - 1}개 데이터 행 감지`
                : "Excel용 CSV UTF-8"}
            </span>
          </label>
          <button
            className="primary wide"
            disabled={!csv || submitting}
            onClick={() => void command({ action: "dry_run", sourceName, csv })}
          >
            {submitting ? "처리 중…" : "2. 오류 없이 검증"}
          </button>
        </article>
        <article className="hs-import-card">
          <h3>검증 결과</h3>
          {dryRun ? (
            <>
              <div className="hs-import-counts">
                <span>
                  <b>{dryRun.row_count}</b>전체
                </span>
                <span className="clear">
                  <b>{dryRun.valid_count}</b>정상
                </span>
                <span className={dryRun.error_count ? "due" : "clear"}>
                  <b>{dryRun.error_count}</b>오류
                </span>
              </div>
              {dryRun.summary?.sampleErrors?.map((item) => (
                <p className="hs-error-row" key={item.rowNumber}>
                  행 {item.rowNumber}: {item.errors.join(" · ")}
                </p>
              ))}
              <button
                className="primary wide"
                disabled={dryRun.error_count > 0 || submitting}
                onClick={() =>
                  void command({ action: "commit", jobId: dryRun.id })
                }
              >
                3. {dryRun.valid_count}건 반영
              </button>
            </>
          ) : (
            <div className="hs-empty">
              <b>검증 결과가 아직 없습니다.</b>
              <span>파일을 선택하고 dry-run을 실행하세요.</span>
            </div>
          )}
          {message && (
            <p className="hs-message" role="status">
              {message}
            </p>
          )}
        </article>
      </div>
      <div className="hs-table-wrap">
        <table className="hs-data-table">
          <thead>
            <tr>
              <th>파일/작업</th>
              <th>모드</th>
              <th>처리 건수</th>
              <th>상태</th>
              <th>실행자/일시</th>
              <th>복구</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <b>{job.source_name}</b>
                  <small>{job.id}</small>
                </td>
                <td>{job.mode}</td>
                <td>
                  {job.valid_count}/{job.row_count} · 오류 {job.error_count}
                </td>
                <td>
                  <span
                    className={`hs-state ${job.status === "COMPLETED" ? "confirmed" : job.status === "ROLLED_BACK" ? "cancelled" : "tentative"}`}
                  >
                    {job.status}
                  </span>
                </td>
                <td>
                  <small>
                    {new Date(job.created_at).toLocaleString("ko-KR")}
                  </small>
                </td>
                <td>
                  {job.mode === "COMMIT" && job.status === "COMPLETED" ? (
                    <button
                      className="secondary"
                      disabled={submitting}
                      onClick={() =>
                        void command({ action: "rollback", jobId: job.id })
                      }
                    >
                      롤백
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
