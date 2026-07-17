/** Builds bounded multi-row ARI/outbox inserts after range facts are batch-loaded. */

type Row = Record<string, unknown>;
type Mapping = { id: unknown; connection_id: unknown };

export function buildAriDeltaInserts({
  dates,
  mapping,
  physical,
  controls,
  booked,
  held,
  revisions,
  now,
  makeId = () => crypto.randomUUID(),
}: {
  dates: string[];
  mapping: Mapping;
  physical: { count?: number; base_rate?: number } | undefined;
  controls: Map<string, Row>;
  booked: Map<string, Row>;
  held: Map<string, Row>;
  revisions: Map<string, Row>;
  now: string;
  makeId?: () => string;
}) {
  const ariValues: unknown[] = [];
  const outboxValues: unknown[] = [];
  for (const stayDate of dates) {
    const control = controls.get(stayDate);
    const sellLimit = control?.sell_limit == null ? Number(physical?.count ?? 0) : Number(control.sell_limit);
    const available = Boolean(control?.closed)
      ? 0
      : Math.max(0, sellLimit - Number(booked.get(stayDate)?.count ?? 0) - Number(held.get(stayDate)?.count ?? 0));
    const payload = {
      roomstosell: available,
      closed: Boolean(control?.closed),
      minimumstay: Number(control?.min_stay ?? 1),
      closedonarrival: Boolean(control?.close_to_arrival),
      closedondeparture: Boolean(control?.close_to_departure),
      rate: Number(control?.price_override ?? physical?.base_rate ?? 0),
      currency: "KRW",
      date: stayDate,
    };
    const ariId = makeId();
    ariValues.push(
      ariId,
      mapping.connection_id,
      mapping.id,
      stayDate,
      Number(revisions.get(stayDate)?.revision ?? 1),
      available,
      payload.closed,
      payload.minimumstay,
      payload.closedonarrival,
      payload.closedondeparture,
      payload.rate,
      payload,
      now,
    );
    outboxValues.push(makeId(), ariId, payload, now);
  }
  return {
    ariRows: dates.map(() => "(?,pms_current_property_id(),?,?,?,?,?,?,?,?,?,?,'KRW',?,'PENDING',0,?,NULL,NULL)").join(","),
    ariValues,
    outboxRows: dates.map(() => "(?,pms_current_property_id(),'channel.ari_delta','ari_update',?,?,'PENDING',0,?,NULL)").join(","),
    outboxValues,
  };
}
