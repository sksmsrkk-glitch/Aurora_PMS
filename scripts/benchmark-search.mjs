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
  Math.min(100_000, Number(process.env.SEARCH_BENCHMARK_ROWS) || 10_000),
);
const samplesPerQuery = Math.max(
  5,
  Math.min(100, Number(process.env.SEARCH_BENCHMARK_SAMPLES) || 20),
);
const concurrentUsers = Math.max(
  2,
  Math.min(24, Number(process.env.SEARCH_BENCHMARK_CONCURRENCY) || 8),
);
const sequentialP95BudgetMs = Math.max(
  50,
  Number(process.env.SEARCH_BENCHMARK_SEQUENTIAL_P95_MS) || 1_500,
);
const concurrentP95BudgetMs = Math.max(
  sequentialP95BudgetMs,
  Number(process.env.SEARCH_BENCHMARK_CONCURRENT_P95_MS) || 5_000,
);
const roomNumberWidth = Math.max(5, String(targetSize).length);
const fixtureMode =
  targetSize >= 50_000 || process.env.SEARCH_BENCHMARK_BULK === "true"
    ? "bulk-production-shape"
    : "trigger-maintained";
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
  connection: {
    application_name: `talos-search-benchmark-${suffix}`,
  },
});

const principal = {
  workspaceAccess: { frontdesk: "NONE", rooms: "READ", finance: "NONE" },
  piiMode: "FULL",
};
const fixtureStartedAt = performance.now();
let fixtureSetupMs = 0;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  ];
}

async function timedSearch(db, query) {
  const startedAt = performance.now();
  const result = await loadPmsSearch(
    db,
    new URLSearchParams({ q: query, kind: "rooms", limit: "8" }),
    principal,
  );
  const durationMs = performance.now() - startedAt;
  if (!result.total)
    throw new Error(`Benchmark query returned zero rows: ${query}`);
  return durationMs;
}

async function measure(db, query, samples = samplesPerQuery) {
  await loadPmsSearch(
    db,
    new URLSearchParams({ q: query, kind: "rooms", limit: "8" }),
    principal,
  );
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    durations.push(await timedSearch(db, query));
  }
  return {
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
  };
}

async function measureConcurrent(db, queries) {
  // Warm every pool connection before measuring so the concurrent result
  // reflects query capacity instead of one-time socket and TLS setup.
  await Promise.all(
    Array.from({ length: concurrentUsers }, (_, index) =>
      timedSearch(db, queries[index % queries.length]),
    ),
  );
  const startedAt = performance.now();
  const durations = (
    await Promise.all(
      Array.from({ length: concurrentUsers }, async (_, userIndex) => {
        const userDurations = [];
        for (let sample = 0; sample < samplesPerQuery; sample += 1) {
          userDurations.push(
            await timedSearch(
              db,
              queries[(userIndex + sample) % queries.length],
            ),
          );
        }
        return userDurations;
      }),
    )
  ).flat();
  const elapsedMs = performance.now() - startedAt;
  return {
    users: concurrentUsers,
    operations: durations.length,
    throughputPerSecond: Number(
      ((durations.length * 1_000) / elapsedMs).toFixed(2),
    ),
    p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
  };
}

async function insertRoomsThroughProductionTriggers() {
  await sql`
    INSERT INTO rooms(
      id,property_id,room_type_id,number,floor,
      front_desk_status,housekeeping_status,active
    )
    SELECT
      ${`room-search-bench-${suffix}-`} || series::text,
      ${propertyId},
      ${roomTypeId},
      'B-' || lpad(series::text,${roomNumberWidth},'0'),
      ((series-1)/100)::int + 1,
      'VACANT',
      'INSPECTED',
      true
    FROM generate_series(1,${targetSize}) series
  `;
}

async function insertBulkProductionShapeFixture() {
  // A 100k capacity test must measure the read path, not spend most of its
  // wall-clock budget calling the row-level maintenance trigger 100k times.
  // The small CI benchmark still exercises that trigger. Here we bulk-load the
  // same production tables and normalized term shape in an isolated loopback DB.
  await sql.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL session_replication_role = replica");
    await transaction`
      INSERT INTO rooms(
        id,property_id,room_type_id,number,floor,
        front_desk_status,housekeeping_status,active
      )
      SELECT
        ${`room-search-bench-${suffix}-`} || series::text,
        ${propertyId},
        ${roomTypeId},
        'B-' || lpad(series::text,${roomNumberWidth},'0'),
        ((series-1)/100)::int + 1,
        'VACANT',
        'INSPECTED',
        true
      FROM generate_series(1,${targetSize}) series
    `;
  });
  await sql`
    INSERT INTO pms_search_documents(
      property_id,entity_kind,entity_id,search_text,compact_text,initial_text,
      sort_at,indexed_at
    )
    SELECT
      room.property_id,
      'ROOM',
      room.id,
      public.talos_search_normalize(
        concat_ws(
          ' ',room.number,'BENCH','Benchmark Suite',room.floor,
          room.front_desk_status,room.housekeeping_status
        )
      ),
      public.talos_search_compact(
        concat_ws(
          ' ',room.number,'BENCH','Benchmark Suite',room.floor,
          room.front_desk_status,room.housekeeping_status
        )
      ),
      public.talos_search_compact(
        public.talos_search_korean_initials(
          concat_ws(
            ' ',room.number,'BENCH','Benchmark Suite',room.floor,
            room.front_desk_status,room.housekeeping_status
          )
        )
      ),
      clock_timestamp(),
      clock_timestamp()
    FROM rooms room
    WHERE room.property_id=${propertyId}
  `;
  await sql`
    INSERT INTO pms_search_terms(property_id,entity_kind,entity_id,term)
    SELECT DISTINCT
      document.property_id,
      document.entity_kind,
      document.entity_id,
      candidate.term
    FROM pms_search_documents document
    CROSS JOIN LATERAL (
      SELECT token term
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
      UNION
      SELECT public.talos_search_compact(token)
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
      UNION
      SELECT document.compact_text
      UNION
      SELECT document.initial_text
    ) candidate
    WHERE document.property_id=${propertyId}
      AND document.entity_kind='ROOM'
      AND char_length(candidate.term) BETWEEN 2 AND 120
    ON CONFLICT DO NOTHING
  `;
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
  if (fixtureMode === "trigger-maintained") {
    await insertRoomsThroughProductionTriggers();
  } else {
    await insertBulkProductionShapeFixture();
  }
  await sql`ANALYZE pms_search_documents`;
  await sql`ANALYZE pms_search_terms`;
  await sql`ANALYZE rooms`;
  fixtureSetupMs = performance.now() - fixtureStartedAt;

  process.env.DATABASE_URL = databaseUrl;
  const db = scopePmsDatabase(
    getPmsDatabase({ DATABASE_URL: databaseUrl }),
    propertyId,
  );
  const exactRoom = `B-${String(targetSize - 1).padStart(roomNumberWidth, "0")}`;
  const queries = [exactRoom, `${exactRoom.slice(0, -1)}X`, "Benchmark"];
  const report = {
    rows: targetSize,
    fixtureMode,
    fixtureSetupMs: Number(fixtureSetupMs.toFixed(2)),
    samplesPerQuery,
    budgetsMs: {
      sequentialP95: sequentialP95BudgetMs,
      concurrentP95: concurrentP95BudgetMs,
    },
    exact: await measure(db, queries[0]),
    typo: await measure(db, queries[1]),
    broad: await measure(db, queries[2]),
    concurrent: await measureConcurrent(db, queries),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const sequentialWorst = Math.max(
    report.exact.p95Ms,
    report.typo.p95Ms,
    report.broad.p95Ms,
  );
  if (sequentialWorst > sequentialP95BudgetMs) {
    throw new Error(
      `Sequential search p95 ${sequentialWorst}ms exceeded ${sequentialP95BudgetMs}ms`,
    );
  }
  if (report.concurrent.p95Ms > concurrentP95BudgetMs) {
    throw new Error(
      `Concurrent search p95 ${report.concurrent.p95Ms}ms exceeded ${concurrentP95BudgetMs}ms`,
    );
  }
} finally {
  await closePmsDatabase();
  // The production schema intentionally does not cascade room-type deletion;
  // clean synthetic children in dependency order and leave no benchmark data.
  await sql`DELETE FROM rooms WHERE property_id=${propertyId}`;
  await sql`DELETE FROM room_types WHERE property_id=${propertyId}`;
  await sql`DELETE FROM properties WHERE id=${propertyId}`;
  await sql`DELETE FROM organizations WHERE id=${organizationId}`;
  const residue = await sql`
    SELECT
      (SELECT count(*)::int FROM rooms WHERE property_id=${propertyId}) rooms,
      (SELECT count(*)::int FROM room_types WHERE property_id=${propertyId}) room_types,
      (SELECT count(*)::int FROM pms_search_documents WHERE property_id=${propertyId}) documents,
      (SELECT count(*)::int FROM pms_search_terms WHERE property_id=${propertyId}) terms,
      (SELECT count(*)::int FROM properties WHERE id=${propertyId}) properties,
      (SELECT count(*)::int FROM organizations WHERE id=${organizationId}) organizations
  `;
  const cleanupVerified = Object.values(residue[0]).every(
    (value) => Number(value) === 0,
  );
  if (!cleanupVerified) {
    throw new Error(`Search benchmark cleanup left residue: ${JSON.stringify(residue[0])}`);
  }
  await sql.end({ timeout: 2 });
}
