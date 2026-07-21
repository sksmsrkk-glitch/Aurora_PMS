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
import { demoAuthenticationEnabled } from "../app/api/pms/auth-policy.ts";
import { clientAddress } from "../app/api/request-policy.ts";
import { assertSafeQaTarget } from "../scripts/qa-target.mjs";

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
