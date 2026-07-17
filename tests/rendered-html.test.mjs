/** Source-rendering and documentation completeness regression tests. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
test("PMS product shell replaces the starter", async () => {
  const [page, layout, css, route, hosting, reporting, workbook, roomMaster, inventory, accounting, contracts, extended, dialogController, listSearch, brandMark] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"), readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"), readFile(new URL("app/api/pms/route.ts", root), "utf8"), readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("app/api/pms/reporting.ts", root), "utf8"), readFile(new URL("app/xlsx-export.ts", root), "utf8"), readFile(new URL("app/room-master.tsx", root), "utf8"),
    readFile(new URL("app/inventory-calendar.tsx",root),"utf8"),readFile(new URL("app/accounting-center.tsx",root),"utf8"),readFile(new URL("app/channel-contracts.tsx",root),"utf8"),readFile(new URL("app/api/pms/extended.ts",root),"utf8"),readFile(new URL("app/dialog-controller.ts",root),"utf8"),readFile(new URL("app/list-search.tsx",root),"utf8"),readFile(new URL("public/brand/aurora-mark-192.png",root)),
  ]);
  assert.match(layout, /Aurora PMS/); assert.match(layout, /lang="ko"/); assert.match(layout, /https:\/\/static\.toss\.im\/tps\/main\.css/);
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
  assert.match(css,/Aurora Flow UI/);assert.match(css,/#3182f6/i);assert.match(css,/Toss Product Sans/);assert.match(css,/html,body,body \*\{font-family:var\(--aurora-font-product\)!important\}/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/focus-visible/);
  assert.match(route,/PMS_DEMO_USER_EMAIL/);assert.match(route,/runtimeBindings/);assert.doesNotMatch(route,/cloudflare:workers/);
  assert.match(inventory,/최대 730일|730일까지/);assert.match(inventory,/기간 벌크 요금·재고/);assert.match(inventory,/호텔 입금가/);
  assert.match(accounting,/회계 & 손익/);assert.match(accounting,/복식부기 분개장/);assert.match(accounting,/채널 정산 원장/);
  assert.match(contracts,/수수료 계약/);assert.match(contracts,/입금가 계약/);assert.match(extended,/bulk_update_inventory_controls/);assert.match(extended,/reverse_accounting_entry/);
  assert.match(reporting,/accounting_journal/);assert.match(reporting,/channel_settlements/);assert.match(css,/master-modal>\.modal-actions/);
  assert.match(page,/headerSearchEnabled/);assert.match(page,/filteredRooms/);assert.match(page,/search-clear/);assert.match(page,/객실 청소 상태 필터/);
  assert.match(dialogController,/MutationObserver/);assert.match(dialogController,/event\.key === "Escape"/);assert.match(dialogController,/focusableSelector/);assert.match(dialogController,/dialog-open/);
  assert.match(dialogController,/focusOrigins/);assert.match(dialogController,/input:not\(\[disabled\]\)/);assert.match(listSearch,/role="search"/);assert.match(listSearch,/aria-live="polite"/);assert.match(listSearch,/\$\{label\} 지우기/);
  assert.match(roomMaster,/filteredTypes/);assert.match(inventory,/재고 객실 타입 검색/);assert.match(accounting,/회계 전표 검색/);assert.match(contracts,/채널 계약 검색/);assert.match(page,/비즈니스 블록 검색/);assert.match(page,/폴리오와 매출채권 검색/);
  assert.match(css,/\.dialog-open/);assert.match(css,/min-height:44px/);assert.match(css,/safe-area-inset-bottom/);assert.match(css,/\.modal-backdrop,\.drawer-backdrop\{align-items:flex-end/);assert.match(css,/\.app-shell\{grid-template-columns:minmax\(0,1fr\);min-width:0\}/);
  assert.match(roomMaster,/aria-modal="true"/);assert.match(inventory,/aria-label="요금 및 재고 편집"/);assert.match(accounting,/aria-label=\{config\.title\}/);assert.match(contracts,/aria-label="채널 계약 편집"/);
  assert.match(page,/\/brand\/aurora-mark-192\.png/);assert.match(page,/mobile-brand/);assert.match(page,/AURORA PMS/);assert.match(layout,/aurora-mark-64\.png/);assert.match(css,/Aurora PMS generated brand mark/);assert.deepEqual([...brandMark.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
});

test("every rendered button has an action, submit contract, or intentional disabled state", async () => {
  for (const file of ["app/page.tsx", "app/list-search.tsx", "app/room-master.tsx", "app/reports-center.tsx", "app/inventory-calendar.tsx", "app/accounting-center.tsx", "app/channel-contracts.tsx", "app/homepage-manager.tsx", "app/hotel/HotelSearchForm.tsx", "app/hotel/book/BookingClient.tsx"]) {
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

test("README is a complete architecture, development, and operations handoff", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const section of [
    "## 현재 릴리스 현황",
    "## 전체 아키텍처",
    "## 아키텍처 결정 기록",
    "## 화면 및 기능 명세",
    "## 마이그레이션 카탈로그",
    "## API 상세 개발 명세",
    "## 개발자 가이드",
    "## 장애 대응 Runbook",
    "## 프로덕션 전환 전 필수 작업",
    "## 구현 변경 이력",
  ]) assert.ok(readme.includes(section), `README section missing: ${section}`);
  for (const contract of [
    "bulk_update_inventory_controls",
    "upsert_channel_contract",
    "accrue_channel_settlement",
    "post_accounting_entry",
    "update_website_settings",
    "upload_website_media",
    "202607170004_website_cms.sql",
    "202607160005_settlement_contract_snapshot.sql",
    "https://static.toss.im/tps/main.css",
    "https://aurora-pms-gilt.vercel.app",
    "PMS_DEMO_USER_EMAIL",
  ]) assert.ok(readme.includes(contract), `README contract missing: ${contract}`);
  assert.ok(readme.split("\n").length > 1_000, "README should remain a detailed handoff document");
});

test("maintained source files include explanatory comments",async()=>{
  const files=[];
  for(const directory of ["app","db","scripts","tests","worker"]){
    const entries=await readdir(new URL(`${directory}/`,root),{recursive:true});
    for(const entry of entries)if(/\.(?:ts|tsx|mjs|js)$/u.test(entry))files.push(`${directory}/${entry.replaceAll("\\","/")}`);
  }
  const uncommented=[];
  for(const file of files){const source=await readFile(new URL(file,root),"utf8"),header=source.split("\n").slice(0,10).join("\n");if(!/\/\*\*/u.test(header))uncommented.push(file);}
  assert.deepEqual(uncommented,[],`source files without comments: ${uncommented.join(", ")}`);
});
