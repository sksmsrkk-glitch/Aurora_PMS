/** Direct-booking availability and reservation domain service. */
import { createHash } from "node:crypto";
import { getPmsDatabase, type PmsDatabase, type PmsPreparedStatement, type PmsRuntimeBindings } from "../../../db/pms-database";

const MAX_STAY_NIGHTS = 30;

const bindings: PmsRuntimeBindings = {
  DATABASE_URL: process.env.DATABASE_URL,
};

type PropertyRow = { id: string; name: string; currency: string; business_date: string };
type RoomTypeRow = { id: string; code: string; name: string; marketing_name: string; short_description: string; amenities_json: string; image_url: string | null; base_rate: number; capacity: number; physical: number };
type ControlRow = { room_type_id: string; stay_date: string; sell_limit: number | null; closed: number; website_closed: number; min_stay: number; close_to_arrival: number; close_to_departure: number; price_override: number | null };
type CountRow = { room_type_id: string; stay_date: string; count: number };

export type PublicNight = { date: string; rate: number; available: number };
export type PublicRoomOffer = {
  roomTypeId: string;
  code: string;
  name: string;
  description: string;
  imageUrl: string | null;
  amenities: string[];
  capacity: number;
  available: number;
  averageNightlyRate: number;
  total: number;
  currency: string;
  nights: PublicNight[];
};

export type AvailabilityResult = {
  property: { name: string; currency: string; businessDate: string };
  search: { arrival: string; departure: string; adults: number; children: number; nights: number };
  offers: PublicRoomOffer[];
};

function database() {
  return getPmsDatabase(bindings);
}

function isoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function bookingDates(arrival: string, departure: string) {
  if (!isoDate(arrival) || !isoDate(departure)) return [];
  const cursor = new Date(`${arrival}T00:00:00.000Z`);
  const end = new Date(`${departure}T00:00:00.000Z`);
  const dates: string[] = [];
  while (cursor < end && dates.length <= MAX_STAY_NIGHTS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor.valueOf() === end.valueOf() && dates.length <= MAX_STAY_NIGHTS ? dates : [];
}

function integer(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizedEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function emailHash(value: string) {
  return createHash("sha256").update(normalizedEmail(value), "utf8").digest("hex");
}

function requiredText(value: unknown, maximum: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254;
}

function validPhone(value: string) {
  return /^[0-9+() .-]{7,24}$/u.test(value);
}

function controlKey(roomTypeId: string, stayDate: string) {
  return `${roomTypeId}:${stayDate}`;
}

/**
 * Loads every input needed for one authoritative availability projection in a
 * single database batch. Sellable supply is physical in-service rooms capped by
 * sell_limit, less committed reservation nights and inventory-deducting group
 * blocks; website_closed is evaluated separately from the global stop-sell.
 */
async function availabilityRows(db: PmsDatabase, arrival: string, departure: string) {
  const [propertyResult, typesResult, controlsResult, soldResult, heldResult] = await db.batch([
    db.prepare("SELECT id,name,currency,business_date FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare("SELECT rt.id,rt.code,rt.name,rw.marketing_name,rw.short_description,rw.amenities_json,rt.base_rate,rt.capacity,COUNT(r.id) physical,(SELECT wm.public_url FROM website_media wm WHERE wm.property_id=rt.property_id AND wm.room_type_id=rt.id AND wm.active=1 ORDER BY CASE wm.role WHEN 'CARD' THEN 0 WHEN 'HERO' THEN 1 ELSE 2 END,wm.sort_order LIMIT 1) image_url FROM room_types rt JOIN room_type_website rw ON rw.property_id=rt.property_id AND rw.room_type_id=rt.id LEFT JOIN rooms r ON r.room_type_id=rt.id AND r.property_id=rt.property_id AND r.active=1 AND r.housekeeping_status<>'OUT_OF_SERVICE' WHERE rt.property_id='prop-seoul' AND rt.active=1 AND rw.published=1 GROUP BY rt.id,rt.code,rt.name,rw.marketing_name,rw.short_description,rw.amenities_json,rt.base_rate,rt.capacity,rw.display_order ORDER BY rw.display_order,rt.base_rate"),
    db.prepare("SELECT room_type_id,stay_date,sell_limit,closed,website_closed,min_stay,close_to_arrival,close_to_departure,price_override FROM inventory_controls WHERE property_id='prop-seoul' AND stay_date>=? AND stay_date<=?").bind(arrival, departure),
    db.prepare("SELECT room_type_id,stay_date,COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND stay_date>=? AND stay_date<? GROUP BY room_type_id,stay_date").bind(arrival, departure),
    db.prepare("SELECT bi.room_type_id,bi.stay_date,COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id AND bb.property_id=bi.property_id WHERE bi.property_id='prop-seoul' AND bi.stay_date>=? AND bi.stay_date<? AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE') GROUP BY bi.room_type_id,bi.stay_date").bind(arrival, departure),
  ]);
  return {
    property: propertyResult.results[0] as PropertyRow | undefined,
    roomTypes: typesResult.results as RoomTypeRow[],
    controls: controlsResult.results as ControlRow[],
    sold: soldResult.results as CountRow[],
    held: heldResult.results as CountRow[],
  };
}

export async function getAvailability(input: { arrival: string; departure: string; adults: unknown; children: unknown }): Promise<AvailabilityResult> {
  const dates = bookingDates(input.arrival, input.departure);
  const adults = integer(input.adults, 1, 12);
  const children = integer(input.children, 0, 8);
  if (!dates.length) throw new BookingError("체크인·체크아웃 날짜를 확인해 주세요. 한 번에 최대 30박까지 예약할 수 있습니다.", 400, "INVALID_DATES");
  if (adults === null || children === null) throw new BookingError("투숙 인원을 확인해 주세요.", 400, "INVALID_OCCUPANCY");

  const rows = await availabilityRows(database(), input.arrival, input.departure);
  if (!rows.property) throw new BookingError("호텔 판매 정보를 불러올 수 없습니다.", 503, "PROPERTY_UNAVAILABLE");
  if (input.arrival < rows.property.business_date) throw new BookingError("호텔 영업일보다 이전 날짜는 예약할 수 없습니다.", 400, "PAST_BUSINESS_DATE");

  const controls = new Map(rows.controls.map((row) => [controlKey(String(row.room_type_id), String(row.stay_date)), row]));
  const sold = new Map(rows.sold.map((row) => [controlKey(String(row.room_type_id), String(row.stay_date)), Number(row.count)]));
  const held = new Map(rows.held.map((row) => [controlKey(String(row.room_type_id), String(row.stay_date)), Number(row.count)]));
  const offers: PublicRoomOffer[] = [];

  // An offer is valid only when every night satisfies occupancy, stay controls,
  // direct-channel publication, and positive inventory. The minimum availability
  // across all nights is what the booking engine may safely advertise.
  for (const roomType of rows.roomTypes) {
    if (adults + children > Number(roomType.capacity) || Number(roomType.physical) < 1) continue;
    const arrivalControl = controls.get(controlKey(roomType.id, input.arrival));
    const departureControl = controls.get(controlKey(roomType.id, input.departure));
    const minimumStay = Math.max(1, ...dates.map((date) => Number(controls.get(controlKey(roomType.id, date))?.min_stay ?? 1)));
    if (Number(arrivalControl?.close_to_arrival ?? 0) === 1 || Number(departureControl?.close_to_departure ?? 0) === 1 || dates.length < minimumStay) continue;

    let closed = false;
    const nights = dates.map((date) => {
      const key = controlKey(roomType.id, date);
      const control = controls.get(key);
      const physical = Number(roomType.physical);
      const sellLimit = control?.sell_limit == null ? physical : Math.min(physical, Number(control.sell_limit));
      const available = Math.max(0, sellLimit - Number(sold.get(key) ?? 0) - Number(held.get(key) ?? 0));
      // The direct-channel switch is independent from the global/OTA stop-sell.
      if (Number(control?.closed ?? 0) === 1 || Number(control?.website_closed ?? 0) === 1 || available < 1) closed = true;
      return { date, rate: Number(control?.price_override ?? roomType.base_rate), available };
    });
    if (closed) continue;
    const total = nights.reduce((sum, night) => sum + night.rate, 0);
    offers.push({
      roomTypeId: roomType.id,
      code: roomType.code,
      name: roomType.marketing_name || roomType.name,
      description: roomType.short_description,
      imageUrl: roomType.image_url || null,
      amenities: (() => {
        try {
          const parsed = JSON.parse(roomType.amenities_json || "[]");
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
        } catch {
          return [];
        }
      })(),
      capacity: Number(roomType.capacity),
      available: Math.min(...nights.map((night) => night.available)),
      averageNightlyRate: Math.round(total / nights.length),
      total,
      currency: rows.property.currency,
      nights,
    });
  }

  return {
    property: { name: rows.property.name, currency: rows.property.currency, businessDate: rows.property.business_date },
    search: { arrival: input.arrival, departure: input.departure, adults, children, nights: dates.length },
    offers,
  };
}

export class BookingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "BOOKING_ERROR") {
    super(message);
  }
}

export type ReservationInput = {
  arrival?: unknown; departure?: unknown; adults?: unknown; children?: unknown; roomTypeId?: unknown;
  firstName?: unknown; lastName?: unknown; email?: unknown; phone?: unknown; specialRequests?: unknown;
};

export async function createWebReservation(input: ReservationInput, idempotencyKey: string) {
  const arrival = requiredText(input.arrival, 10);
  const departure = requiredText(input.departure, 10);
  const roomTypeId = requiredText(input.roomTypeId, 64);
  const firstName = requiredText(input.firstName, 80);
  const lastName = requiredText(input.lastName, 80);
  const email = requiredText(input.email, 254);
  const phone = requiredText(input.phone, 24);
  const specialRequests = typeof input.specialRequests === "string" ? input.specialRequests.trim().slice(0, 1000) : "";
  if (!arrival || !departure || !roomTypeId || !firstName || !lastName || !email || !phone || !validEmail(email) || !validPhone(phone)) {
    throw new BookingError("예약자 이름, 이메일, 연락처와 투숙 정보를 정확히 입력해 주세요.", 400, "INVALID_GUEST");
  }

  const db = database();
  // A retried browser request returns the original reservation instead of
  // consuming another room. The unique booking_requests key is the final guard
  // when concurrent requests pass this fast-path lookup at the same time.
  const existing = await db.prepare("SELECT r.id,r.confirmation_no,r.arrival_date,r.departure_date,r.status FROM booking_requests b JOIN reservations r ON r.id=b.reservation_id AND r.property_id=b.property_id WHERE b.property_id='prop-seoul' AND b.idempotency_key=? LIMIT 1").bind(idempotencyKey).first<Record<string, unknown>>();
  if (existing) return { reservationId: String(existing.id), confirmation: String(existing.confirmation_no), arrival: String(existing.arrival_date), departure: String(existing.departure_date), status: String(existing.status), duplicate: true };

  const availability = await getAvailability({ arrival, departure, adults: input.adults, children: input.children });
  const offer = availability.offers.find((item) => item.roomTypeId === roomTypeId);
  if (!offer) throw new BookingError("선택한 객실은 방금 판매 완료되었거나 판매 조건이 변경되었습니다. 다시 검색해 주세요.", 409, "OFFER_CHANGED");

  const adults = availability.search.adults;
  const children = availability.search.children;
  const now = new Date().toISOString();
  const guestId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const confirmation = `AUR-${arrival.replaceAll("-", "").slice(2)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const actor = "booking-engine@aurora.hotel";
  const average = Math.round(offer.total / offer.nights.length);
  // Guest, reservation, per-night inventory/rates, idempotency receipt, audit,
  // and outbox event form one atomic unit. Capacity constraints on the night rows
  // reject a stale offer rather than allowing an oversell after the availability read.
  const statements: PmsPreparedStatement[] = [
    db.prepare("INSERT INTO guests(id,property_id,first_name,last_name,email,phone,vip_level,nationality,preferences,created_at) VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', NULL, '[]', ?)").bind(guestId, firstName, lastName, normalizedEmail(email), phone, now),
    db.prepare("INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', ?, ?, 'Aurora Web', 'WEB-DIRECT', ?, NULL, ?, 1, ?, ?)").bind(reservationId, confirmation, guestId, roomTypeId, arrival, departure, adults, children, average, specialRequests, now, now),
    db.prepare("INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,payee_account_profile_id,status,created_at,created_by,closed_at) VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`, reservationId, now, actor),
  ];
  for (const night of offer.nights) {
    statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId, roomTypeId, night.date));
    statements.push(db.prepare("INSERT INTO reservation_rate_nights(id,property_id,reservation_id,room_type_id,stay_date,sell_rate,currency,rate_plan,created_at) VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'WEB-DIRECT', ?)").bind(crypto.randomUUID(), reservationId, roomTypeId, night.date, night.rate, offer.currency, now));
  }
  statements.push(
    db.prepare("INSERT INTO booking_requests(id,property_id,idempotency_key,reservation_id,email_hash,created_at) VALUES (?, 'prop-seoul', ?, ?, ?, ?)").bind(crypto.randomUUID(), idempotencyKey, reservationId, emailHash(email), now),
    db.prepare("INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?, 'prop-seoul', ?, 'WEB_BOOKING_CREATED', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(), actor, reservationId, JSON.stringify({ confirmation, arrival, departure, roomTypeId, adults, children, total: offer.total, currency: offer.currency }), now),
    db.prepare("INSERT INTO outbox_events(id,property_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,published_at) VALUES (?, 'prop-seoul', 'reservation.web_created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(), reservationId, JSON.stringify({ reservationId, confirmation, email: normalizedEmail(email), total: offer.total, currency: offer.currency }), now),
  );
  await db.batch(statements);
  return { reservationId, confirmation, arrival, departure, status: "DUE_IN", roomType: offer.name, total: offer.total, currency: offer.currency, duplicate: false };
}

export async function findWebReservationByIdempotency(idempotencyKey: string) {
  const existing = await database().prepare("SELECT r.id,r.confirmation_no,r.arrival_date,r.departure_date,r.status FROM booking_requests b JOIN reservations r ON r.id=b.reservation_id AND r.property_id=b.property_id WHERE b.property_id='prop-seoul' AND b.idempotency_key=? LIMIT 1").bind(idempotencyKey).first<Record<string, unknown>>();
  return existing ? { reservationId: String(existing.id), confirmation: String(existing.confirmation_no), arrival: String(existing.arrival_date), departure: String(existing.departure_date), status: String(existing.status), duplicate: true } : null;
}

export async function cancelWebReservation(input: { confirmation?: unknown; email?: unknown; lastName?: unknown }) {
  const confirmation = requiredText(input.confirmation, 64)?.toUpperCase();
  const email = requiredText(input.email, 254);
  const lastName = requiredText(input.lastName, 80);
  if (!confirmation || !email || !lastName || !validEmail(email)) throw new BookingError("예약번호, 이메일, 성을 정확히 입력해 주세요.", 400, "INVALID_LOOKUP");
  const db = database();
  const reservation = await db.prepare("SELECT r.id,r.status,r.arrival_date,r.departure_date,r.confirmation_no,r.version,g.last_name,b.email_hash,p.business_date FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id JOIN booking_requests b ON b.reservation_id=r.id AND b.property_id=r.property_id JOIN properties p ON p.id=r.property_id WHERE r.property_id='prop-seoul' AND r.confirmation_no=? LIMIT 1").bind(confirmation).first<Record<string, unknown>>();
  if (!reservation || String(reservation.email_hash) !== emailHash(email) || String(reservation.last_name).toLocaleLowerCase("en-US") !== lastName.toLocaleLowerCase("en-US")) {
    throw new BookingError("입력한 정보와 일치하는 웹 예약을 찾지 못했습니다.", 404, "BOOKING_NOT_FOUND");
  }
  if (reservation.status === "CANCELLED") return { confirmation, status: "CANCELLED", duplicate: true };
  if (reservation.status !== "DUE_IN" || String(reservation.arrival_date) <= String(reservation.business_date)) {
    throw new BookingError("도착일 당일 이후 또는 이미 처리 중인 예약은 호텔로 문의해 주세요.", 409, "CANCELLATION_RESTRICTED");
  }
  const now = new Date().toISOString();
  const actor = "booking-engine@aurora.hotel";
  // Cancellation is an optimistic, atomic state transition. Releasing both room-
  // and type-level night rows in the same batch makes inventory immediately agree
  // with the reservation status while audit and integration consumers see one event.
  await db.batch([
    db.prepare("INSERT INTO reservation_transitions(id,property_id,reservation_id,from_status,to_status,actor,created_at) VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'CANCELLED', ?, ?)").bind(crypto.randomUUID(), reservation.id, actor, now),
    db.prepare("UPDATE reservations SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND property_id='prop-seoul' AND status='DUE_IN' AND version=?").bind(now, reservation.id, Number(reservation.version)),
    db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservation.id),
    db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND property_id='prop-seoul'").bind(reservation.id),
    db.prepare("INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?, 'prop-seoul', ?, 'WEB_BOOKING_CANCELLED', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(), actor, reservation.id, JSON.stringify({ status: reservation.status }), JSON.stringify({ status: "CANCELLED" }), now),
    db.prepare("INSERT INTO outbox_events(id,property_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,published_at) VALUES (?, 'prop-seoul', 'reservation.web_cancelled', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(), reservation.id, JSON.stringify({ reservationId: reservation.id, confirmation }), now),
  ]);
  return { confirmation, status: "CANCELLED", duplicate: false };
}
