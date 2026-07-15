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
  assert.match(route, /role_assignments/); assert.match(route, /open_cashier/); assert.match(route, /run_night_audit/); assert.match(route, /reservation_transition_from_uq/); assert.match(route, /folio_entries_no_update/);
  assert.match(page, /캐셔 개시/); assert.match(page, /객실료 전기 및 영업일 마감/);
  assert.match(route, /reservation_type_nights_capacity/); assert.match(route, /edit_reservation/); assert.match(route, /move_room/); assert.match(route, /update_inventory_control/);
  assert.match(page, /재고 & 요금/); assert.match(page, /예약 수정/); assert.match(page, /룸 무브/); assert.match(page, /판매 제어/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});
