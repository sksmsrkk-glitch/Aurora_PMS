/** ARI range generation must stay O(1) database statements as days increase. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAriDeltaInserts } from "../app/api/pms/ari-delta.ts";
import { compilePostgresParameters } from "../db/postgres-parameters.mjs";
import { addIsoDays } from "../lib/format.ts";

test("365-day ARI projection produces two valid bulk inserts", () => {
  const dates = Array.from({ length: 365 }, (_, index) => addIsoDays("2032-01-01", index));
  let sequence = 0;
  const result = buildAriDeltaInserts({
    dates,
    mapping: { id: "mapping-1", connection_id: "connection-1" },
    physical: { count: 20, base_rate: 200_000 },
    controls: new Map([[dates[0], { sell_limit: 10, closed: false, min_stay: 2, price_override: 250_000 }]]),
    booked: new Map([[dates[0], { count: 3 }]]),
    held: new Map([[dates[0], { count: 2 }]]),
    revisions: new Map([[dates[0], { revision: 4 }]]),
    now: "2031-12-01T00:00:00.000Z",
    makeId: () => `id-${sequence++}`,
  });

  assert.equal(result.ariValues.length, 365 * 13);
  assert.equal(result.outboxValues.length, 365 * 4);
  assert.equal(result.ariRows.split("),(").length, 365);
  assert.equal(result.outboxRows.split("),(").length, 365);
  const ariSql = `INSERT INTO ari_updates(id,property_id,connection_id,mapping_id,stay_date,revision,available,closed,min_stay,close_to_arrival,close_to_departure,rate,currency,payload_json,status,attempts,created_at,sent_at,last_error) VALUES ${result.ariRows}`;
  const outboxSql = `INSERT INTO outbox_events(id,property_id,topic,aggregate_type,aggregate_id,payload_json,status,attempts,created_at,published_at) VALUES ${result.outboxRows}`;
  assert.match(compilePostgresParameters(ariSql, result.ariValues.length), /\$4745/u);
  assert.match(compilePostgresParameters(outboxSql, result.outboxValues.length), /\$1460/u);
  const firstPayload = result.ariValues[11];
  assert.deepEqual(firstPayload, {
    roomstosell: 5,
    closed: false,
    minimumstay: 2,
    closedonarrival: false,
    closedondeparture: false,
    rate: 250_000,
    currency: "KRW",
    date: "2032-01-01",
  });
});
