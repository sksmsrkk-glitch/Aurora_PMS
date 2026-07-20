import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertImportHeaders,
  normalizedImportRow,
  parseCsv,
  validateImportRow,
} from "../app/import-csv.ts";
import { validatedWorkerEndpoint } from "../app/worker-kick.ts";
import { hasUsableTenantAccess } from "../app/tenant-access.ts";
import { assertStagingDatabaseTarget } from "../scripts/staging-db-target.mjs";

test("CSV migration parser handles quoted commas, escaped quotes and CRLF", () => {
  const rows = parseCsv(
    '\ufeffcode,name,base_rate,capacity,description\r\nDLX,"Deluxe, River",180000,2,"A ""quiet"" room"\r\n',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.name, "Deluxe, River");
  assert.equal(rows[0].data.description, 'A "quiet" room');
  assertImportHeaders("ROOM_TYPES", rows[0].data);
  const normalized = normalizedImportRow("ROOM_TYPES", rows[0].data);
  assert.deepEqual(validateImportRow("ROOM_TYPES", normalized), []);
});

test("CSV migration validation rejects unsafe references and invalid stay ranges", () => {
  const normalized = normalizedImportRow("RESERVATIONS", {
    external_id: "R-1",
    confirmation_no: "C-1",
    guest_external_id: "G-1",
    room_type_code: "DLX",
    arrival_date: "2026-07-20",
    departure_date: "2026-07-20",
    nightly_rate: "-1",
  });
  const errors = validateImportRow("RESERVATIONS", normalized);
  assert.ok(errors.some((error) => error.includes("출발일")));
  assert.ok(errors.some((error) => error.includes("nightly_rate")));
});

test("multi-hotel migration establishes control plane, JIT support and durable workers", () => {
  const migration = readFileSync(
      new URL(
        "../supabase/migrations/202607190016_multihotel_saas_control_plane.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    database = readFileSync(
      new URL("../db/pms-database.ts", import.meta.url),
      "utf8",
    );
  for (const table of [
    "organizations",
    "organization_memberships",
    "property_domains",
    "property_subscriptions",
    "support_access_grants",
    "data_import_jobs",
    "worker_jobs",
    "backup_runs",
    "service_incidents",
  ])
    assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}\\b`));
  assert.match(database, /FOR UPDATE SKIP LOCKED/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.doesNotMatch(migration, /pms_execute\s*\(/iu);
});

test("public booking routes derive tenant scope from a verified hostname", () => {
  const availability = readFileSync(
      new URL("../app/api/booking/availability/route.ts", import.meta.url),
      "utf8",
    ),
    reservation = readFileSync(
      new URL("../app/api/booking/reservations/route.ts", import.meta.url),
      "utf8",
    ),
    resolver = readFileSync(
      new URL("../app/api/booking/property-resolver.ts", import.meta.url),
      "utf8",
    ),
    database = readFileSync(
      new URL("../db/pms-database.ts", import.meta.url),
      "utf8",
    );
  assert.match(availability, /resolvePublicPropertyForRequest/u);
  assert.match(reservation, /resolvePublicPropertyForRequest/u);
  assert.match(database, /d\.status='ACTIVE'/u);
  assert.match(resolver, /NODE_ENV\s*!==\s*"production"/u);
});

test("worker kick accepts only a trusted fixed endpoint", () => {
  assert.equal(
    validatedWorkerEndpoint(
      "https://aurora.example.com/api/internal/worker",
      "production",
    )?.href,
    "https://aurora.example.com/api/internal/worker",
  );
  for (const unsafe of [
    "http://attacker.example/api/internal/worker",
    "https://attacker.example/other",
    "https://user:secret@attacker.example/api/internal/worker",
    "https://attacker.example/api/internal/worker?redirect=1",
  ])
    assert.equal(validatedWorkerEndpoint(unsafe, "production"), null);
});

test("login entry rejects suspended-only tenants without creating a redirect loop", () => {
  assert.equal(
    hasUsableTenantAccess([{ subscription_status: "SUSPENDED" }]),
    false,
  );
  assert.equal(
    hasUsableTenantAccess([{ subscription_status: "CANCELLED" }]),
    false,
  );
  assert.equal(
    hasUsableTenantAccess([{ subscription_status: "ACTIVE" }]),
    true,
  );
  assert.equal(
    hasUsableTenantAccess([{ subscription_status: "SUSPENDED" }], 1),
    true,
    "an active, MFA-gated support grant remains a valid entry path",
  );
});

test("staging database release guard requires environment, opt-in and exact project ref", () => {
  const keys = [
      "DATABASE_URL",
      "SUPABASE_URL",
      "PMS_ENVIRONMENT",
      "PMS_ALLOW_DESTRUCTIVE_QA",
      "PMS_QA_PROJECT_REF",
    ],
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(assertStagingDatabaseTarget, /Staging database target rejected/u);
    process.env.DATABASE_URL = "postgres://user:secret@db.example.test:5432/postgres";
    process.env.SUPABASE_URL = "https://isolated-staging.supabase.co";
    process.env.PMS_ENVIRONMENT = "staging";
    process.env.PMS_ALLOW_DESTRUCTIVE_QA = "true";
    process.env.PMS_QA_PROJECT_REF = "isolated-staging";
    assert.equal(assertStagingDatabaseTarget().projectRef, "isolated-staging");
    process.env.PMS_QA_PROJECT_REF = "production-ref";
    assert.throws(assertStagingDatabaseTarget, /actualRef=isolated-staging/u);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
