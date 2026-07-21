/** Shared mutation receipt contract between the PMS command API and UI. */

export type PmsMutationReceipt = {
  ok: true;
  mutation: {
    id: string;
    action: string;
    domain: string;
    replayed: boolean;
    entity: { type: string; id: string } | null;
  };
  invalidates: string[];
};

const domainReadModels: Record<string, readonly string[]> = {
  reservation: ["reservations", "inventory"],
  rooms: ["rooms", "inventory", "hotel"],
  inventory: ["inventory", "hotel"],
  groups: ["groups", "inventory"],
  finance: ["finance", "accounting"],
  integrations: ["channels", "inventory", "accounting"],
  accounting: ["accounting"],
  website: ["website", "hotel"],
  operations: ["operations", "reservations", "rooms", "finance"],
  users: ["users"],
};

const entityIdFields = [
  "reservationId",
  "roomId",
  "roomTypeId",
  "blockId",
  "entryId",
  "windowId",
  "invoiceId",
  "connectionId",
  "mappingId",
  "messageId",
  "eventId",
  "journalEntryId",
  "settlementId",
  "mediaId",
  "ratePlanId",
  "assignmentId",
  "venueId",
  "banquetReservationId",
  "memberId",
] as const;

/**
 * Builds a deliberately small command acknowledgement. Read-model payloads are
 * refreshed through cache invalidation instead of being recomputed in every POST.
 */
export function pmsMutationReceipt({
  action,
  domain,
  idempotencyKey,
  body,
  replayed = false,
}: {
  action: string;
  domain: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  replayed?: boolean;
}): PmsMutationReceipt {
  const entityId = entityIdFields
    .map((field) => body[field])
    .find((value) => typeof value === "string" && value.length > 0);
  const invalidates = Array.from(
    new Set(["core", "full", ...(domainReadModels[domain] ?? [])]),
  );
  return {
    ok: true,
    mutation: {
      id: idempotencyKey,
      action,
      domain,
      replayed,
      entity:
        typeof entityId === "string" ? { type: domain, id: entityId } : null,
    },
    invalidates,
  };
}
