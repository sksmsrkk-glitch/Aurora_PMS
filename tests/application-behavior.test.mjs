/** Behavior-focused contracts for routing, mutation receipts, QA safety, and UI actions. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import ts from "typescript";
import {
  PMS_WORKSPACES,
  parsePmsWorkspace,
  pmsWorkspacePath,
} from "../app/pms-workspaces.ts";
import { pmsMutationReceipt } from "../app/pms-mutation.ts";
import {
  failedMutationQueryKeys,
  successfulMutationQueryKeys,
} from "../app/pms-query-invalidation.ts";
import { demoAuthenticationEnabled } from "../app/api/pms/auth-policy.ts";
import { clientAddress } from "../app/api/request-policy.ts";
import { assertSafeQaTarget } from "../scripts/qa-target.mjs";
import { safeRouteError } from "../app/api/safe-route-error.ts";
import {
  normalizedRoomMoveMode,
  occupiedRoomDates,
} from "../app/room-board-coverage.ts";
import {
  reservationCommandInput,
  reservationDisplayedTotal,
} from "../app/reservation-wizard.tsx";
import { cssUrl } from "../app/css-url.ts";
import { voucherAdapterRequest } from "../app/api/internal/worker/voucher-adapter-contract.ts";

const root = new URL("../", import.meta.url);

test("all PMS workspaces round-trip through bookmarkable routes", async () => {
  assert.equal(PMS_WORKSPACES.length, 14);
  for (const workspace of PMS_WORKSPACES) {
    const path = pmsWorkspacePath(workspace);
    assert.equal(parsePmsWorkspace(path.slice(1)), workspace);
    await access(new URL(`app/(pms)/${workspace}/page.tsx`, root));
  }
  assert.equal(parsePmsWorkspace("unknown"), null);
});

test("mutation receipts carry entity references without God payload data", () => {
  const result = pmsMutationReceipt({
    action: "edit_reservation",
    domain: "reservation",
    idempotencyKey: "retry-001",
    body: { reservationId: "reservation-42" },
  });
  assert.deepEqual(result.mutation.entity, {
    type: "reservation",
    id: "reservation-42",
  });
  assert.deepEqual(result.invalidates, [
    "core",
    "full",
    "reservations",
    "inventory",
  ]);
  assert.equal("reservations" in result, false);
  assert.equal("finance" in result, false);
});

test("mutation cache policy refreshes active room-board and detail projections", () => {
  const success = successfulMutationQueryKeys({ invalidates: ["core", "full"] });
  assert.ok(success.some((key) => key.join(":") === "pms:frontdesk"));
  assert.ok(success.some((key) => key.join(":") === "pms:reservation-detail"));
  assert.deepEqual(failedMutationQueryKeys(), [
    ["pms", "frontdesk"],
    ["pms", "reservation-detail"],
  ]);
});

test("unexpected route errors expose only a correlation id", () => {
  const logged = [];
  const result = safeRouteError(new Error("SELECT secret_column FROM internal_table"), {
    context: "behavior-test",
    logger: (entry) => logged.push(entry),
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.includes("secret_column"), false);
  assert.match(result.body.errorId, /^[0-9a-f-]{36}$/u);
  assert.equal(logged[0].message, "SELECT secret_column FROM internal_table");
});

test("known route conflicts use a stable public message", () => {
  const result = safeRouteError(new Error("duplicate key value exposes table_name"), {
    context: "behavior-test",
    conflicts: [{ pattern: /duplicate/iu, error: "대상이 이미 존재합니다." }],
    logger: () => assert.fail("known conflicts must not enter unexpected logging"),
  });
  assert.deepEqual(result, { status: 409, body: { error: "대상이 이미 존재합니다." } });
});

test("room-board covered dates disable every cell beneath an assignment span", () => {
  const occupied = occupiedRoomDates([
    { dates: ["2032-01-01", "2032-01-02"] },
    { dates: ["2032-01-04"] },
  ]);
  assert.equal(occupied.has("2032-01-01"), true);
  assert.equal(occupied.has("2032-01-03"), false);
  assert.equal(occupied.has("2032-01-04"), true);
});

test("arrival-day room moves are normalized to an unambiguous full stay", () => {
  assert.equal(
    normalizedRoomMoveMode("FROM_DATE", "2032-01-01", "2032-01-01"),
    "FULL",
  );
  assert.equal(
    normalizedRoomMoveMode("FROM_DATE", "2032-01-01", "2032-01-02"),
    "FROM_DATE",
  );
});

test("reservation review and command use the same nightly-rate resolver", () => {
  const search = {
    arrival: "2032-01-01",
    departure: "2032-01-03",
    adults: "2",
    children: "0",
  };
  const guest = { nightlyRate: "" };
  const automatic = reservationCommandInput(search, guest, "rt", "BAR", 125000);
  assert.equal(automatic.nightlyRate, "125000");
  assert.equal(automatic.rateOverride, "false");
  assert.equal(
    reservationDisplayedTotal("", { average: 125000, total: 260000 }, 2),
    260000,
  );
  const manual = reservationCommandInput(
    search,
    { nightlyRate: "140000" },
    "rt",
    "BAR",
    125000,
  );
  assert.equal(manual.nightlyRate, "140000");
  assert.equal(manual.rateOverride, "true");
  assert.equal(
    reservationDisplayedTotal("140000", { average: 125000, total: 260000 }, 2),
    280000,
  );
});

test("CMS image URLs cannot terminate their quoted CSS url token", () => {
  const serialized = cssUrl('https://cdn.example/hero)name("night").webp');
  assert.equal(
    serialized,
    'url("https://cdn.example/hero%29name%28%22night%22%29.webp")',
  );
});

test("voucher provider retries preserve the delivery idempotency contract", () => {
  const input = {
    deliveryId: "delivery-42",
    secret: "adapter-secret",
    from: "hotel@example.com",
    to: "guest@example.com",
    subject: "Reservation",
    html: "<p>Voucher</p>",
    propertyId: "hotel-a",
    reservationId: "reservation-a",
    language: "KO",
    showAmount: true,
  };
  const first = voucherAdapterRequest(input);
  const retry = voucherAdapterRequest(input);
  assert.deepEqual(retry, first);
  assert.equal(first.headers["Idempotency-Key"], input.deliveryId);
  assert.equal(first.body.messageId, input.deliveryId);
});

test("demo authentication is flag, environment, and constant-token bound", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    PMS_ALLOW_DEMO_AUTH: process.env.PMS_ALLOW_DEMO_AUTH,
    PMS_DEMO_AUTH_TOKEN: process.env.PMS_DEMO_AUTH_TOKEN,
  };
  const token = "behavior-test-token-with-more-than-32-characters";
  try {
    process.env.PMS_ALLOW_DEMO_AUTH = "true";
    process.env.PMS_DEMO_AUTH_TOKEN = token;
    process.env.NODE_ENV = "development";
    assert.equal(
      demoAuthenticationEnabled(
        new Request("http://localhost", {
          headers: { "x-aurora-demo-token": token },
        }),
      ),
      true,
    );
    assert.equal(
      demoAuthenticationEnabled(
        new Request("http://localhost", {
          headers: { "x-aurora-demo-token": `${token}x` },
        }),
      ),
      false,
    );
    process.env.NODE_ENV = "production";
    assert.equal(
      demoAuthenticationEnabled(
        new Request("https://pms.example", {
          headers: { "x-aurora-demo-token": token },
        }),
      ),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("client IP headers are ignored unless the deployment declares a proxy", () => {
  const previous = {
    VERCEL: process.env.VERCEL,
    PMS_TRUST_PROXY: process.env.PMS_TRUST_PROXY,
  };
  const request = new Request("https://pms.example", {
    headers: {
      "x-forwarded-for": "203.0.113.8, 10.0.0.1",
      "x-vercel-forwarded-for": "198.51.100.9",
    },
  });
  try {
    delete process.env.VERCEL;
    delete process.env.PMS_TRUST_PROXY;
    assert.equal(clientAddress(request), "untrusted-direct-client");
    process.env.PMS_TRUST_PROXY = "true";
    assert.equal(clientAddress(request), "203.0.113.8");
    process.env.VERCEL = "1";
    assert.equal(clientAddress(request), "198.51.100.9");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("stateful QA refuses production and accepts only matching staging health", async () => {
  const previous = {
    PMS_QA_ENVIRONMENT: process.env.PMS_QA_ENVIRONMENT,
    PMS_QA_PROJECT_REF: process.env.PMS_QA_PROJECT_REF,
    PMS_QA_CONFIRM: process.env.PMS_QA_CONFIRM,
  };
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.PMS_QA_ENVIRONMENT;
    await assert.rejects(
      assertSafeQaTarget("https://preview.example"),
      /requires PMS_QA_ENVIRONMENT=staging/u,
    );
    process.env.PMS_QA_ENVIRONMENT = "staging";
    process.env.PMS_QA_CONFIRM = "AURORA_STAGING_ONLY";
    process.env.PMS_QA_PROJECT_REF = "isolated-staging-ref";
    globalThis.fetch = async () =>
      Response.json({
        status: "ok",
        environment: "staging",
        qaAllowed: true,
        databaseProjectRef: "isolated-staging-ref",
      });
    await assert.doesNotReject(assertSafeQaTarget("https://preview.example"));
    process.env.PMS_QA_PROJECT_REF = "tnbxreeidezidckemflb";
    await assert.rejects(
      assertSafeQaTarget("https://preview.example"),
      /dedicated non-production/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("every rendered button has an action or submit contract", async () => {
  const files = [
    "app/(pms)/_components/pms-shell.tsx",
    "app/list-search.tsx",
    "app/room-master.tsx",
    "app/reports-center.tsx",
    "app/inventory-calendar.tsx",
    "app/frontdesk-workbench.tsx",
    "app/global-pms-search.tsx",
    "app/reservation-wizard.tsx",
    "app/accounting-center.tsx",
    "app/channel-contracts.tsx",
    "app/homepage-manager.tsx",
    "app/hotel/HotelSearchForm.tsx",
    "app/hotel/book/BookingClient.tsx",
  ];
  for (const file of files) {
    const sourceText = await readFile(new URL(file, root), "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const inert = [];
    const visit = (node) => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(source) === "button"
      ) {
        const names = node.openingElement.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => attribute.name.getText(source));
        if (
          !names.includes("onClick") &&
          !names.includes("type") &&
          !names.includes("disabled")
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          inert.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepEqual(inert, [], `inert buttons: ${inert.join(", ")}`);
  }
});

test("README keeps operational handoff sections without a line-count quota", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const section of [
    "## 현재 릴리스 현황",
    "## 전체 아키텍처",
    "## 마이그레이션 카탈로그",
    "## API 상세 개발 명세",
    "## 개발자 가이드",
    "## 장애 대응 Runbook",
  ]) {
    assert.ok(readme.includes(section), `README section missing: ${section}`);
  }
});
