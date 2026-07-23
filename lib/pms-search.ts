/**
 * Domain search documents for every client-side PMS list.
 *
 * Keeping field selection here makes the shared normalization engine an
 * executable contract: UI components cannot silently drift back to ad-hoc
 * lowercase/includes filters, and tests exercise the same functions that the
 * production screens call.
 */
import { matchesSearch, personDisplaySearchText } from "./search";

type RoomSearchRow = {
  number: unknown;
  room_type_code: unknown;
  room_type_name: unknown;
  floor: unknown;
  assignee?: unknown;
  front_desk_status: string;
  housekeeping_status: string;
};

export function roomMatchesSearch(
  room: RoomSearchRow,
  query: unknown,
  statusLabels: Record<string, string>,
): boolean {
  return matchesSearch(
    [
      room.number,
      room.room_type_code,
      room.room_type_name,
      room.floor,
      room.assignee,
      statusLabels[room.front_desk_status] ?? room.front_desk_status,
      statusLabels[room.housekeeping_status] ?? room.housekeeping_status,
    ],
    query,
  );
}

export function businessBlockMatchesSearch(
  block: {
    code: unknown;
    name: unknown;
    status: unknown;
    account_name?: unknown;
    group_name?: unknown;
    arrival_date: unknown;
    departure_date: unknown;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      block.code,
      block.name,
      block.status,
      block.account_name,
      block.group_name,
      block.arrival_date,
      block.departure_date,
    ],
    query,
  );
}

export function salesAccountMatchesSearch(
  account: {
    name: unknown;
    type: unknown;
    external_id?: unknown;
    credit_status: unknown;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [account.name, account.type, account.external_id, account.credit_status],
    query,
  );
}

export function folioWindowMatchesSearch(
  window: {
    name: unknown;
    guest_name: unknown;
    confirmation_no: unknown;
    status: unknown;
    window_no: unknown;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      window.name,
      window.guest_name,
      personDisplaySearchText(window.guest_name),
      window.confirmation_no,
      window.status,
      window.window_no,
    ],
    query,
  );
}

export function arInvoiceMatchesSearch(
  invoice: {
    invoice_no: unknown;
    account_name: unknown;
    status: unknown;
    due_date: unknown;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      invoice.invoice_no,
      invoice.account_name,
      invoice.status,
      invoice.due_date,
    ],
    query,
  );
}

export function inventoryRoomTypeMatchesSearch(
  type: { code: unknown; name: unknown },
  query: unknown,
): boolean {
  return matchesSearch([type.code, type.name], query);
}

export function channelCatalogMatchesSearch(
  channel: {
    display_name: unknown;
    provider_code: unknown;
    description?: unknown;
    supplier_name?: unknown;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      channel.display_name,
      channel.provider_code,
      channel.description,
      channel.supplier_name,
    ],
    query,
  );
}

export function websiteRoomMatchesSearch(
  room: {
    code: unknown;
    name: unknown;
    marketing_name?: unknown;
    published: boolean | null;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      room.code,
      room.name,
      room.marketing_name,
      room.published ? "홈페이지 노출 공개" : "비노출 숨김",
    ],
    query,
  );
}

export function staffUserMatchesSearch(
  user: { display_name: unknown; email: unknown },
  roleLabel: unknown,
  query: unknown,
): boolean {
  return matchesSearch(
    [
      user.display_name,
      personDisplaySearchText(user.display_name),
      user.email,
      roleLabel,
    ],
    query,
  );
}

export function reservationOfferMatchesSearch(
  offer: {
    code: unknown;
    name: unknown;
    plans: Array<{ code: unknown; name: unknown }>;
  },
  query: unknown,
): boolean {
  return matchesSearch(
    [
      offer.code,
      offer.name,
      ...offer.plans.flatMap((plan) => [plan.code, plan.name]),
    ],
    query,
  );
}

/**
 * Occupancy search keeps room-type filtering useful for vacant rooms, while
 * guest/channel/rate filters show only rooms occupied by matching reservations.
 * A matching but unassigned reservation therefore produces an explicit empty
 * room list instead of an apparently unchanged full rack.
 */
export function occupancyRoomsForSearch<
  TRoom extends { id: string; room_type_id: string },
>(
  rooms: TRoom[],
  reservations: Array<{ room_id: string | null }>,
  filters: {
    query: unknown;
    source: unknown;
    ratePlan: unknown;
    roomTypeId: unknown;
  },
): TRoom[] {
  const restrictToMatchedReservations = [
    filters.query,
    filters.source,
    filters.ratePlan,
  ].some((value) => String(value ?? "").trim().length > 0);
  const roomTypeId = String(filters.roomTypeId ?? "").trim();
  const occupiedRoomIds = new Set(
    reservations
      .map((reservation) => reservation.room_id)
      .filter((roomId): roomId is string => Boolean(roomId)),
  );

  return rooms.filter(
    (room) =>
      (!roomTypeId || room.room_type_id === roomTypeId) &&
      (!restrictToMatchedReservations || occupiedRoomIds.has(room.id)),
  );
}
