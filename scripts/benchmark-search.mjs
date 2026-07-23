/**
 * Reproducible search benchmark. It is deliberately locked to loopback
 * PostgreSQL so synthetic hotel/room data can never touch staging or production.
 */
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { loadPmsSearch } from "../app/api/pms/frontdesk-read.ts";
import {
  closePmsDatabase,
  getPmsDatabase,
  scopePmsDatabase,
} from "../db/pms-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "";
const targetSize = Math.max(
  1_000,
  Math.min(50_000, Number(process.env.SEARCH_BENCHMARK_ROWS) || 10_000),
);
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const parsedUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname)) {
  throw new Error("Search benchmark is restricted to a loopback PostgreSQL");
}

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const organizationId = `org-search-bench-${suffix}`;
const propertyId = `prop-search-bench-${suffix}`;
const roomTypeId = `rt-search-bench-${suffix}`;
const sql = postgres(databaseUrl, {
  max: 4,
  prepare: false,
  ssl: false,
  idle_timeout: 2,
});

const principal = {
  workspaceAccess: { frontdesk: "NONE", rooms: "READ", finance: "NONE" },
  piiMode: "FULL",
};

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function measure(db, query, samples = 20) {
  await loadPmsSearch(
    db,
    new URLSearchParams({ q: query, kind: "rooms", limit: "8" }),
    principal,
  );
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const result = await loadPmsSearch(
      db,
      new URLSearchParams({ q: query, kind: "rooms", limit: "8" }),
      principal,
    );
    durations.push(performance.now() - startedAt);
    if (!result.total) throw new Error(`Benchmark query returned zero rows: ${query}`);
  }
  return {
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
  };
}

try {
  await sql`
    INSERT INTO organizations(id,name,slug,status)
    VALUES (
      ${organizationId},'Search Benchmark Organization',
      ${`search-bench-${suffix}`},'ACTIVE'
    )
  `;
  await sql`
    INSERT INTO properties(
      id,name,code,timezone,currency,business_date,organization_id,slug
    ) VALUES (
      ${propertyId},'Search Benchmark Hotel',${`SB-${suffix}`},
      'Asia/Seoul','KRW','2026-07-23',${organizationId},
      ${`search-bench-${suffix}`}
    )
  `;
  await sql`
    INSERT INTO room_types(
      id,property_id,code,name,base_rate,capacity
    ) VALUES (
      ${roomTypeId},${propertyId},'BENCH','Benchmark Suite',100000,2
    )
  `;
  // The production room trigger builds search documents and terms for every
  // row, so the benchmark covers index maintenance and the real read model.
  await sql`
    INSERT INTO rooms(
      id,property_id,room_type_id,number,floor,
      front_desk_status,housekeeping_status,active
    )
    SELECT
      ${`room-search-bench-${suffix}-`} || series::text,
      ${propertyId},
      ${roomTypeId},
      'B-' || lpad(series::text,5,'0'),
      ((series-1)/100)::int + 1,
      'VACANT',
      'INSPECTED',
      true
    FROM generate_series(1,${targetSize}) series
  `;
  await sql`ANALYZE pms_search_documents`;
  await sql`ANALYZE pms_search_terms`;
  await sql`ANALYZE rooms`;

  process.env.DATABASE_URL = databaseUrl;
  const db = scopePmsDatabase(
    getPmsDatabase({ DATABASE_URL: databaseUrl }),
    propertyId,
  );
  const exactRoom = `B-${String(targetSize - 1).padStart(5, "0")}`;
  const report = {
    rows: targetSize,
    samplesPerQuery: 20,
    exact: await measure(db, exactRoom),
    typo: await measure(db, `${exactRoom.slice(0, -1)}X`),
    broad: await measure(db, "Benchmark"),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await closePmsDatabase();
  // The production schema intentionally does not cascade room-type deletion;
  // clean synthetic children in dependency order and leave no benchmark data.
  await sql`DELETE FROM rooms WHERE property_id=${propertyId}`;
  await sql`DELETE FROM room_types WHERE property_id=${propertyId}`;
  await sql`DELETE FROM properties WHERE id=${propertyId}`;
  await sql`DELETE FROM organizations WHERE id=${organizationId}`;
  await sql.end({ timeout: 2 });
}
