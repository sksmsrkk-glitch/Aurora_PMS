import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
test("PMS product shell replaces the starter", async () => {
  const [page, layout, css, route, hosting] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"), readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"), readFile(new URL("app/api/pms/route.ts", root), "utf8"), readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);
  assert.match(layout, /Aurora PMS/); assert.match(layout, /lang="ko"/);
  assert.match(page, /오늘의 오퍼레이션/); assert.match(page, /체크인 완료/); assert.match(page, /야간 감사/); assert.match(page, /새 예약 만들기/);
  assert.match(css, /\.room-grid/); assert.match(css, /@media\(max-width:760px\)/);
  assert.match(route, /room_night_uq/); assert.match(route, /audit_logs/); assert.match(route, /idempotency_keys/); assert.match(route, /outbox_events/); assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});
