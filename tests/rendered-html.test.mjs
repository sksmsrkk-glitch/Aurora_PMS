import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
test("PMS product shell replaces the starter", async () => {
  const [page, layout, css, route, hosting, reporting, workbook, roomMaster] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"), readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"), readFile(new URL("app/api/pms/route.ts", root), "utf8"), readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("app/api/pms/reporting.ts", root), "utf8"), readFile(new URL("app/xlsx-export.ts", root), "utf8"), readFile(new URL("app/room-master.tsx", root), "utf8"),
  ]);
  assert.match(layout, /Aurora PMS/); assert.match(layout, /lang="ko"/);
  assert.match(page, /오늘의 오퍼레이션/); assert.match(page, /체크인 완료/); assert.match(page, /야간 감사/); assert.match(page, /새 예약 만들기/);
  assert.match(css, /\.room-grid/); assert.match(css, /@media\(max-width:760px\)/);
  assert.match(route, /room_night_uq/); assert.match(route, /audit_logs/); assert.match(route, /idempotency_keys/); assert.match(route, /outbox_events/); assert.match(hosting, /"d1": "DB"/);
  assert.match(route, /role_assignments/); assert.match(route, /open_cashier/); assert.match(route, /run_night_audit/); assert.match(route, /reservation_transition_from_uq/); assert.match(route, /folio_entries_no_update/);
  assert.match(page, /캐셔 개시/); assert.match(page, /객실료 전기 및 영업일 마감/);
  assert.match(route, /reservation_type_nights_capacity/); assert.match(route, /edit_reservation/); assert.match(route, /move_room/); assert.match(route, /update_inventory_control/);
  assert.match(page, /재고 & 요금/); assert.match(page, /예약 수정/); assert.match(page, /룸 무브/); assert.match(page, /판매 제어/);
  assert.match(route, /business_blocks/); assert.match(route, /block_inventory_capacity_insert/); assert.match(route, /pickup_rooming_entry/); assert.match(route, /cutoff_block/);
  assert.match(page, /그룹 & 세일즈/); assert.match(page, /비즈니스 블록/); assert.match(page, /Rooming List/); assert.match(page, /세일즈 프로필 생성/);
  assert.match(route, /folio_windows/); assert.match(route, /folio_entry_details/); assert.match(route, /split_folio_entry/); assert.match(route, /transfer_to_ar/); assert.match(route, /ar_ledger_no_update/);
  assert.match(page, /폴리오 & AR/); assert.match(page, /전표 분할 이동/); assert.match(page, /AR 청구서/); assert.match(page, /반대전표 생성/);
  assert.match(route, /channel_connections/); assert.match(route, /ari_updates/); assert.match(route, /ingest_channel_message/); assert.match(route, /replay_channel_message/); assert.match(route, /integration_attempts_no_update/);
  assert.match(page, /채널 허브/); assert.match(page, /ARI 매핑 & Delta/); assert.match(page, /INBOUND DLQ/); assert.match(page, /Transactional Outbox/);
  assert.match(page,/리포트 센터/);assert.match(page,/객실 마스터/);assert.match(route,/export_report/);assert.match(route,/bulk_create_rooms/);assert.match(route,/REPORT_EXPORT/);
  assert.match(reporting,/점유율 · ADR · RevPAR/);assert.match(reporting,/최대 367일/);assert.match(reporting,/integration_delivery_attempts/);assert.match(roomMaster,/최대 500실/);
  assert.match(workbook,/openxmlformats-officedocument\.spreadsheetml\.sheet/);assert.match(workbook,/Parameters/);assert.match(workbook,/autoFilter/);assert.doesNotMatch(workbook,/from "xlsx"/);
  assert.match(page,/quickPanel/);assert.match(page,/frontdeskFilter/);assert.match(page,/Cmd\/Ctrl|metaKey\|\|event\.ctrlKey/);assert.match(page,/aria-pressed/);assert.match(page,/onReview/);
  assert.match(css,/Aurora Flow UI/);assert.match(css,/#3182f6/i);assert.match(css,/Toss Product Sans/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/focus-visible/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});

test("every rendered button has an action, submit contract, or intentional disabled state", async () => {
  for (const file of ["app/page.tsx", "app/room-master.tsx", "app/reports-center.tsx"]) {
    const sourceText = await readFile(new URL(file, root), "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inert = [];
    const visit = (node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "button") {
        const names = node.openingElement.attributes.properties.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(source));
        if (!names.includes("onClick") && !names.includes("type") && !names.includes("disabled")) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          inert.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepEqual(inert, [], `inert buttons: ${inert.join(", ")}`);
  }
});
