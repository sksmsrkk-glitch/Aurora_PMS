/** Destructive staging workflow QA spanning every PMS operating domain. */
import assert from "node:assert/strict";
import { assertSafeQaTarget } from "./qa-target.mjs";

const baseUrl = (process.env.PMS_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
// Every run receives a compact namespace for records it creates. The workflow is
// intentionally not a cleanup test: immutable ledger/audit records must remain, so
// uniqueness and later inspection depend on this run identifier.
const runId = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
const qaCode = `Q${runId}`.slice(0, 12);
const roomPrefix = `Q${runId.slice(-5)}`;
const results = [];
let sessionCookie = "";
const demoToken=process.env.PMS_DEMO_AUTH_TOKEN || "";

const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const record = (name, detail = "OK") => {
  results.push({ name, detail });
  console.log(`✓ ${name}${detail === "OK" ? "" : ` · ${detail}`}`);
};

async function request(path, options = {}) {
  // Keep HTTP parsing and timing in one place so a non-JSON error page cannot be
  // mistaken for a domain assertion failure later in the workflow.
  const started = performance.now();
  const headers = new Headers(options.headers);
  if (sessionCookie) headers.set("Cookie", sessionCookie);
  if (demoToken) headers.set("x-aurora-demo-token",demoToken);
  // Bound regressions below the platform's five-minute function timeout so QA
  // returns an actionable endpoint and action name instead of hanging silently.
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, signal:options.signal||AbortSignal.timeout(90_000) });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch { throw new Error(`${options.method || "GET"} ${path} returned invalid JSON (${response.status}): ${text.slice(0, 240)}`); }
  return { response, json, elapsed: Math.round(performance.now() - started) };
}

async function authenticateIfConfigured() {
  const email=process.env.PMS_TEST_EMAIL;
  const password=process.env.PMS_TEST_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) throw new Error("PMS_TEST_EMAIL and PMS_TEST_PASSWORD must be provided together");
  const response=await fetch(`${baseUrl}/api/auth/login`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email,password}),
  });
  if (!response.ok) throw new Error(`QA authentication failed (${response.status})`);
  sessionCookie=response.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
  if (!sessionCookie) throw new Error("QA authentication did not return session cookies");
}

async function snapshot() {
  const { response, json, elapsed } = await request("/api/pms", { headers: { Accept: "application/json" } });
  assert.equal(response.status, 200, json?.error || "snapshot failed");
  return { data: json, elapsed };
}

async function action(name, payload = {}, options = {}) {
  // Mutations always carry a unique idempotency key unless a checkpoint supplies a
  // stable key specifically to verify replay behavior.
  const idempotencyKey = options.idempotencyKey || `qa:${runId}:${name}:${crypto.randomUUID()}`;
  const result = await request("/api/pms", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ action: name, ...payload }),
  });
  const expected = options.expectStatus || 200;
  assert.equal(result.response.status, expected, `${name}: ${result.json?.error || result.response.status}`);
  return { ...result, idempotencyKey };
}

const findReservation = (data, lastName) => data.reservations.find((item) => item.first_name === `QA${runId}` && item.last_name === lastName);

async function createReservation(lastName, roomTypeId, arrivalDate, departureDate, roomId = "") {
  const created = await action("create_reservation", {
    firstName: `QA${runId}`, lastName, email: `qa.${runId.toLowerCase()}@example.com`, phone: "010-0000-0000",
    arrivalDate, departureDate, roomTypeId, roomId, source: "Direct", ratePlan: "QA", nightlyRate: "110000", eta: "12:00",
  });
  const reservation = findReservation(created.json, lastName);
  assert.ok(reservation, `reservation ${lastName} was not created`);
  return { data: created.json, reservation };
}

async function main() {
  // First verify shell, authentication, and read projections before creating
  // persistent QA data used by the remaining domain checkpoints.
  await assertSafeQaTarget(baseUrl);
  await authenticateIfConfigured();
  const pageHeaders=new Headers();if(sessionCookie)pageHeaders.set("Cookie",sessionCookie);if(demoToken)pageHeaders.set("x-aurora-demo-token",demoToken);
  const page = await fetch(`${baseUrl}/`,{headers:pageHeaders});
  assert.equal(page.status, 200, "dashboard route failed");
  record("대시보드 페이지 로드", `${page.status}`);

  let { data, elapsed } = await snapshot();
  assert.equal(data.principal.role, "PROPERTY_ADMIN");
  const businessDate = data.property.business_date;
  record("Supabase 실데이터 스냅샷", `${elapsed}ms`);

  // An interrupted staging run can leave only this QA principal's cashier open.
  // Close that recoverable fixture before creating the new run's cashier session;
  // immutable financial and audit history is preserved for later inspection.
  if(data.controls.openCashier){
    await action("close_cashier",{countedAmount:String(data.controls.openCashier.opening_amount||0)});
    data=(await snapshot()).data;
    record("중단 QA 캐셔 복구 마감");
  }

  const reportKeys = ["reservations", "occupancy", "financials", "accounting_journal", "channel_settlements", "ar", "housekeeping", "groups", "channels", "audit", "room_inventory"];
  for (const report of reportKeys) {
    const query = new URLSearchParams({ view: "report", report, from: businessDate, to: addDays(businessDate, 7), page: "1", pageSize: "25", q: "" });
    const response = await request(`/api/pms?${query}`);
    assert.equal(response.response.status, 200, `${report}: ${response.json?.error}`);
    assert.equal(response.json.report.key, report);
  }
  record("표준 리포트 11종 조회·필터");

  for (const format of ["CSV", "XLSX"]) {
    const exported = await action("export_report", { format, report: "reservations", from: businessDate, to: addDays(businessDate, 7), q: `QA${runId}` });
    assert.ok(exported.json.exportId);
    assert.equal(exported.json.export.allowed, true);
  }
  record("CSV·Excel 내보내기 생성");

  // Build isolated room master and inventory fixtures used by every later
  // reservation, group, finance, and integration checkpoint.
  const createdType = await action("create_room_type", { code: qaCode, name: `QA 자동화 ${runId}`, baseRate: "110000", capacity: "2", description: "전체 기능 검증 전용 객실 타입" });
  let roomType = createdType.json.inventory.types.find((item) => item.code === qaCode);
  assert.ok(roomType);
  const typeReplayKey = `qa:${runId}:type-replay`;
  const replayPayload = { code: `${qaCode}R`.slice(0, 12), name: `QA 멱등 ${runId}`, baseRate: "90000", capacity: "1", description: "멱등성 검증" };
  const firstReplay = await action("create_room_type", replayPayload, { idempotencyKey: typeReplayKey });
  const secondReplay = await action("create_room_type", replayPayload, { idempotencyKey: typeReplayKey });
  assert.equal(secondReplay.response.headers.get("x-idempotent-replay"), "true");
  assert.equal(firstReplay.json.inventory.types.filter((item) => item.code === replayPayload.code).length, 1);
  record("객실 타입 생성·멱등 재시도");

  const updatedType = await action("update_room_type", { roomTypeId: roomType.id, expectedVersion: String(roomType.version), code: qaCode, name: `QA 스마트 스위트 ${runId}`, baseRate: "120000", capacity: "3", description: "Toss UX 및 전체 워크플로 검증 타입", active: "true" });
  roomType = updatedType.json.inventory.types.find((item) => item.id === roomType.id);
  assert.equal(Number(roomType.version), 2);
  record("객실 타입 수정·낙관적 잠금");

  const singleNumber = `${roomPrefix}01`;
  let response = await action("create_room", { number: singleNumber, floor: "9", roomTypeId: roomType.id, features: "QA, 금연, 고층" });
  let room = response.json.rooms.find((item) => item.number === singleNumber);
  assert.ok(room);
  response = await action("bulk_create_rooms", { prefix: roomPrefix, startNumber: "2", count: "4", padding: "2", floor: "9", roomTypeId: roomType.id, features: "QA, 자동화" });
  let qaRooms = response.json.rooms.filter((item) => item.room_type_id === roomType.id && item.number.startsWith(roomPrefix)).sort((a, b) => a.number.localeCompare(b.number));
  assert.equal(qaRooms.length, 5);
  response = await action("update_room", { roomId: room.id, expectedVersion: String(room.version), number: room.number, floor: "9", roomTypeId: roomType.id, features: "QA, 금연, 코너룸", active: "true" });
  room = response.json.rooms.find((item) => item.id === room.id);
  assert.match(room.features, /코너룸/);
  record("단일·대량 객실 생성 및 객실 수정", "5실");

  for (const qaRoom of qaRooms) await action("housekeeping", { roomId: qaRoom.id, status: "INSPECTED" });
  data = (await snapshot()).data;
  qaRooms = data.rooms.filter((item) => item.room_type_id === roomType.id && item.number.startsWith(roomPrefix)).sort((a, b) => a.number.localeCompare(b.number));
  assert.ok(qaRooms.every((item) => item.housekeeping_status === "INSPECTED"));
  record("하우스키핑 청소·점검 상태 전환");

  response = await action("update_inventory_control", { roomTypeId: roomType.id, stayDate: addDays(businessDate, 6), sellLimit: "4", closed: "false", minStay: "2", cta: "true", ctd: "false", priceOverride: "135000" });
  const inventoryCell = response.json.inventory.types.find((item) => item.id === roomType.id).cells.find((item) => item.stayDate === addDays(businessDate, 6));
  assert.deepEqual({ sellLimit: inventoryCell.sellLimit, minStay: inventoryCell.minStay, cta: inventoryCell.cta, price: inventoryCell.price }, { sellLimit: 4, minStay: 2, cta: true, price: 135000 });
  record("재고·판매제한·MLOS·CTA·요금 저장");

  response = await action("create_account_profile", { type: "COMPANY", name: `QA 컴퍼니 ${runId}`, externalId: `CO-${runId}`, email: `billing.${runId.toLowerCase()}@example.com`, phone: "02-000-0000", negotiatedRateCode: "QA-CORP", creditStatus: "DIRECT_BILL", notes: "AR 자동화 검증" });
  const company = response.json.groups.accounts.find((item) => item.external_id === `CO-${runId}`);
  assert.ok(company);
  response = await action("create_account_profile", { type: "GROUP", name: `QA 그룹 ${runId}`, externalId: `GR-${runId}`, creditStatus: "CASH", notes: "Rooming list 검증" });
  const group = response.json.groups.accounts.find((item) => item.external_id === `GR-${runId}`);
  assert.ok(group);
  record("회사·그룹 프로필 생성");

  const blockArrival = addDays(businessDate, 3), blockDeparture = addDays(businessDate, 5);
  response = await action("create_business_block", { name: `QA 블록 ${runId}`, code: `B${runId}`.slice(0, 16), accountProfileId: company.id, groupProfileId: group.id, arrivalDate: blockArrival, departureDate: blockDeparture, status: "DEFINITE", reservationMethod: "ROOMING_LIST", deductInventory: "true", cutoffDate: addDays(businessDate, 2), notes: "전체 기능 검증", allocations: JSON.stringify([{ roomTypeId: roomType.id, rooms: 1, rate: 99000 }]) });
  const block = response.json.groups.blocks.find((item) => item.name === `QA 블록 ${runId}`);
  assert.ok(block);
  let blockRow = response.json.groups.inventory.find((item) => item.block_id === block.id && item.stay_date === blockArrival);
  response = await action("update_block_inventory", { blockId: block.id, roomTypeId: roomType.id, stayDate: blockArrival, rooms: "2", rate: "97000" });
  blockRow = response.json.groups.inventory.find((item) => item.block_id === block.id && item.stay_date === blockArrival);
  assert.equal(Number(blockRow.current_rooms), 2);
  response = await action("add_rooming_entry", { blockId: block.id, firstName: `QA${runId}`, lastName: "Rooming", email: `rooming.${runId.toLowerCase()}@example.com`, phone: "010-1111-1111", arrivalDate: blockArrival, departureDate: blockDeparture, roomTypeId: roomType.id, rate: "97000", notes: "픽업 검증" });
  const rooming = response.json.groups.rooming.find((item) => item.block_id === block.id && item.last_name === "Rooming");
  assert.ok(rooming);
  response = await action("pickup_rooming_entry", { entryId: rooming.id });
  assert.equal(response.json.groups.rooming.find((item) => item.id === rooming.id).status, "PICKED_UP");
  response = await action("cutoff_block", { blockId: block.id });
  assert.equal(response.json.groups.blocks.find((item) => item.id === block.id).status, "CUTOFF");
  record("그룹 블록·할당·명단·픽업·Cutoff");

  // Operational lifecycle assertions read the returned server snapshot rather than
  // trusting submitted payloads, including append-only folio and AR transitions.
  if (!response.json.controls.openCashier) response = await action("open_cashier", { openingAmount: "0" });
  assert.ok(response.json.controls.openCashier);
  record("캐셔 개시");

  let created = await createReservation("Operations", roomType.id, businessDate, addDays(businessDate, 1));
  let reservation = created.reservation;
  response = await action("edit_reservation", { reservationId: reservation.id, expectedVersion: String(reservation.version), roomTypeId: roomType.id, arrivalDate: businessDate, departureDate: addDays(businessDate, 2), adults: "2", children: "1", ratePlan: "QA-FLEX", nightlyRate: "125000", eta: "13:30", notes: "수정 워크플로" });
  reservation = response.json.reservations.find((item) => item.id === reservation.id);
  response = await action("assign_room", { reservationId: reservation.id, expectedVersion: String(reservation.version), roomId: qaRooms[0].id });
  reservation = response.json.reservations.find((item) => item.id === reservation.id);
  response = await action("check_in", { reservationId: reservation.id });
  reservation = response.json.reservations.find((item) => item.id === reservation.id);
  assert.equal(reservation.status, "IN_HOUSE");
  response = await action("move_room", { reservationId: reservation.id, expectedVersion: String(reservation.version), roomId: qaRooms[1].id, reason: "QA_ROOM_CHANGE", notes: "룸 무브 버튼 검증" });
  reservation = response.json.reservations.find((item) => item.id === reservation.id);
  assert.equal(reservation.room_id, qaRooms[1].id);
  record("예약 생성·수정·객실 배정·체크인·룸 무브");

  response = await action("create_folio_window", { reservationId: reservation.id, name: "QA Company Window", payeeType: "COMPANY", accountProfileId: company.id });
  const windows = response.json.finance.windows.filter((item) => item.reservation_id === reservation.id).sort((a, b) => a.window_no - b.window_no);
  assert.equal(windows.length, 2);
  response = await action("create_routing_rule", { reservationId: reservation.id, code: "FNB", windowId: windows[1].id });
  assert.ok(response.json.finance.routing.some((item) => item.reservation_id === reservation.id && item.transaction_code === "FNB"));
  response = await action("post_charge", { reservationId: reservation.id, amount: "110000", code: "FNB", description: "QA 조식 패키지" });
  let charge = response.json.finance.entries.find((item) => item.reservation_id === reservation.id && item.kind === "CHARGE" && item.code === "FNB");
  assert.equal(charge.folio_window_id, windows[1].id);
  response = await action("split_folio_entry", { entryId: charge.id, amount: "22000", targetWindowId: windows[0].id, reason: "QA_SPLIT" });
  response = await action("reverse_folio_entry", { entryId: charge.id, reason: "QA_CORRECTION" });
  response = await action("post_payment", { reservationId: reservation.id, amount: "22000", method: "CARD", windowId: windows[0].id });
  let payment = response.json.finance.entries.find((item) => item.reservation_id === reservation.id && item.kind === "PAYMENT" && item.payment_method === "CARD");
  response = await action("refund_payment", { entryId: payment.id, amount: "5000", reason: "QA_PARTIAL_REFUND" });
  response = await action("post_payment", { reservationId: reservation.id, amount: "5000", method: "CARD", windowId: windows[0].id });
  reservation = response.json.reservations.find((item) => item.id === reservation.id);
  assert.equal(Number(reservation.balance), 0);
  response = await action("check_out", { reservationId: reservation.id });
  assert.equal(response.json.reservations.find((item) => item.id === reservation.id).status, "CHECKED_OUT");
  await action("housekeeping", { roomId: qaRooms[1].id, status: "CLEAN" });
  await action("housekeeping", { roomId: qaRooms[1].id, status: "INSPECTED" });
  record("폴리오 창·라우팅·전기·분할·반대전표·결제·환불·체크아웃");

  created = await createReservation("Accounts", roomType.id, businessDate, addDays(businessDate, 2), qaRooms[2].id);
  let arReservation = created.reservation;
  response = await action("check_in", { reservationId: arReservation.id });
  arReservation = response.json.reservations.find((item) => item.id === arReservation.id);
  response = await action("post_charge", { reservationId: arReservation.id, amount: "66000", code: "FNB", description: "QA 법인 연회" });
  const arWindow = response.json.finance.windows.find((item) => item.reservation_id === arReservation.id && item.window_no === 1);
  response = await action("transfer_to_ar", { windowId: arWindow.id, accountProfileId: company.id, dueDate: addDays(businessDate, 30), creditLimit: "1000000" });
  const invoice = response.json.finance.arInvoices.find((item) => item.reservation_id === arReservation.id);
  assert.ok(invoice);
  response = await action("post_ar_payment", { invoiceId: invoice.id, amount: String(invoice.balance), method: "BANK_TRANSFER" });
  assert.equal(response.json.finance.arInvoices.find((item) => item.id === invoice.id).status, "PAID");
  response = await action("check_out", { reservationId: arReservation.id });
  assert.equal(response.json.reservations.find((item) => item.id === arReservation.id).status, "CHECKED_OUT");
  record("AR 이관·청구서·수납·완납");

  created = await createReservation("NoShow", roomType.id, businessDate, addDays(businessDate, 1));
  response = await action("mark_no_show", { reservationId: created.reservation.id });
  assert.equal(response.json.reservations.find((item) => item.id === created.reservation.id).status, "NO_SHOW");
  created = await createReservation("Cancelled", roomType.id, businessDate, addDays(businessDate, 1));
  response = await action("cancel_reservation", { reservationId: created.reservation.id, reason: "QA_USER_REQUEST" });
  assert.equal(response.json.reservations.find((item) => item.id === created.reservation.id).status, "CANCELLED");
  record("노쇼·예약 취소·재고 복원");

  // Validate channel terms, settlement accounting, monotonic inbound revisions,
  // dead-letter replay, and transactional outbox delivery as one integration stage.
  response = await action("create_channel_connection", { provider: "QAOTA", externalPropertyId: `HOTEL-${runId}`, name: `QA OTA ${runId}` });
  const connection = response.json.integrations.connections.find((item) => item.external_property_id === `HOTEL-${runId}`);
  assert.ok(connection);
  response = await action("create_channel_mapping", { connectionId: connection.id, roomTypeId: roomType.id, externalRoomTypeId: `ROOM-${runId}`, ratePlan: "QAOTA", externalRatePlanId: `RATE-${runId}` });
  const mapping = response.json.integrations.mappings.find((item) => item.connection_id === connection.id && item.external_room_type_id === `ROOM-${runId}`);
  assert.ok(mapping);
  response = await action("upsert_channel_contract", { connectionId: connection.id, contractType: "COMMISSION", commissionPercent: "15", settlementCycle: "PER_STAY", paymentTermsDays: "14", validFrom: businessDate, validTo: "" });
  assert.equal(response.json.integrations.contracts.find((item) => item.connection_id === connection.id).contract_type, "COMMISSION");
  const commissionReservation = (await createReservation("Commission", roomType.id, addDays(businessDate, 10), addDays(businessDate, 11))).reservation;
  await action("accrue_channel_settlement", { connectionId: connection.id, reservationId: commissionReservation.id });
  let accounting = await request(`/api/pms?${new URLSearchParams({ view: "accounting", from: businessDate, to: addDays(businessDate, 30) })}`);
  let settlement = accounting.json.settlements.find((item) => item.connection_id === connection.id && item.reservation_id === commissionReservation.id);
  assert.equal(settlement.contract_type, "COMMISSION");
  assert.equal(Number(settlement.channel_cost_amount), 16500);
  await action("mark_channel_settlement_paid", { settlementId: settlement.id });
  record("수수료 계약·정산 발생·입금/지급 완료");

  await action("upsert_channel_contract", { connectionId: connection.id, contractType: "NET_RATE", commissionPercent: "0", settlementCycle: "WEEKLY", paymentTermsDays: "7", validFrom: businessDate, validTo: "" });
  const netArrival = addDays(businessDate, 12), netReservation = (await createReservation("NetRate", roomType.id, netArrival, addDays(netArrival, 1))).reservation;
  await action("bulk_update_inventory_controls", { from: netArrival, to: netArrival, roomTypeIds: JSON.stringify([roomType.id]), weekdays: JSON.stringify([0,1,2,3,4,5,6]), sellLimit: "", priceOverride: "145000", minStay: "1", closed: "false", cta: "false", ctd: "false", mappingId: mapping.id, channelSellRate: "145000", channelNetRate: "112000" });
  const calendar = await request(`/api/pms?${new URLSearchParams({ view: "inventory", from: businessDate, to: addDays(businessDate, 399) })}`);
  assert.equal(calendar.response.status, 200);
  assert.equal(calendar.json.range.days, 400);
  const rateCell = calendar.json.types.find((item) => item.id === roomType.id).cells.find((item) => item.stayDate === netArrival);
  assert.equal(Number(rateCell.channelRates.find((item) => item.mapping_id === mapping.id).net_rate), 112000);
  await action("accrue_channel_settlement", { connectionId: connection.id, reservationId: netReservation.id });
  accounting = await request(`/api/pms?${new URLSearchParams({ view: "accounting", from: businessDate, to: addDays(businessDate, 30) })}`);
  settlement = accounting.json.settlements.find((item) => item.connection_id === connection.id && item.reservation_id === netReservation.id);
  assert.equal(settlement.contract_type, "NET_RATE");
  assert.equal(Number(settlement.hotel_net_amount), 112000);
  assert.equal(Number(settlement.gross_sell_amount) - Number(settlement.channel_cost_amount), Number(settlement.hotel_net_amount));
  record("400일 캘린더·벌크 재고·채널 판매가·입금가 정산");

  const accounts = accounting.json.accounts, expenseAccount = accounts.find((item) => item.code === "5200"), cashAccount = accounts.find((item) => item.code === "1100");
  await action("post_accounting_entry", { businessDate, entryType: "EXPENSE", debitAccountId: expenseAccount.id, creditAccountId: cashAccount.id, amount: "25000", description: `QA 세탁비 ${runId}`, vendor: "QA Linen", department: "HOUSEKEEPING" });
  accounting = await request(`/api/pms?${new URLSearchParams({ view: "accounting", from: businessDate, to: addDays(businessDate, 30) })}`);
  const manual = accounting.json.entries.find((item) => item.description === `QA 세탁비 ${runId}`);
  assert.equal(Number(manual.total_debit), Number(manual.total_credit));
  await action("reverse_accounting_entry", { entryId: manual.id, reason: "QA 회계 반대전표 검증" });
  accounting = await request(`/api/pms?${new URLSearchParams({ view: "accounting", from: businessDate, to: addDays(businessDate, 30) })}`);
  assert.equal(accounting.json.entries.find((item) => item.id === manual.id).status, "REVERSED");
  assert.ok(accounting.json.entries.every((item) => Math.abs(Number(item.total_debit) - Number(item.total_credit)) < 0.01));
  record("수기 복식전표·차대 균형·반대전표");

  response = await action("queue_ari_delta", { mappingId: mapping.id, startDate: businessDate, endDate: addDays(businessDate, 2) });
  let ari = response.json.integrations.ari.find((item) => item.mapping_id === mapping.id && item.status === "PENDING");
  assert.ok(ari);
  response = await action("dispatch_ari_update", { updateId: ari.id, outcome: "FAIL" });
  assert.equal(response.json.integrations.ari.find((item) => item.id === ari.id).status, "FAILED");
  response = await action("dispatch_ari_update", { updateId: ari.id, outcome: "ACK" });
  assert.equal(response.json.integrations.ari.find((item) => item.id === ari.id).status, "SENT");

  const channelPayload = { connectionId: connection.id, messageId: `MSG-${runId}`, eventType: "NEW", externalReservationId: `EXT-${runId}`, revision: "1", externalRoomTypeId: `ROOM-${runId}`, externalRatePlanId: `RATE-${runId}`, firstName: `QA${runId}`, lastName: "Channel", email: `channel.${runId.toLowerCase()}@example.com`, arrivalDate: addDays(businessDate, 7), departureDate: addDays(businessDate, 8), adults: "1", children: "0", nightlyRate: "135000", currency: "KRW" };
  response = await action("ingest_channel_message", channelPayload);
  assert.ok(response.json.integrations.inbound.some((item) => item.message_id === `MSG-${runId}` && item.status === "PROCESSED"));
  const duplicateMessage = await action("ingest_channel_message", channelPayload);
  assert.equal(duplicateMessage.response.headers.get("x-channel-duplicate"), "true");
  response = await action("ingest_channel_message", { ...channelPayload, messageId: `MSG-${runId}-M2`, eventType: "MODIFY", revision: "2", departureDate: addDays(businessDate, 9), nightlyRate: "142000" });
  assert.equal(response.json.integrations.links.find((item) => item.external_reservation_id === `EXT-${runId}`).last_revision, 2);
  response = await action("ingest_channel_message", { ...channelPayload, messageId: `MSG-${runId}-C3`, eventType: "CANCEL", revision: "3" });
  assert.equal(response.json.integrations.links.find((item) => item.external_reservation_id === `EXT-${runId}`).status, "CANCELLED");

  const failedMessageId = `MSG-${runId}-DLQ`;
  await action("ingest_channel_message", { ...channelPayload, messageId: failedMessageId, externalReservationId: `EXT-${runId}-DLQ`, externalRoomTypeId: `BAD-${runId}`, externalRatePlanId: `BADRATE-${runId}` }, { expectStatus: 409 });
  data = (await snapshot()).data;
  const failedMessage = data.integrations.inbound.find((item) => item.message_id === failedMessageId);
  assert.equal(failedMessage.status, "FAILED");
  await action("create_channel_mapping", { connectionId: connection.id, roomTypeId: roomType.id, externalRoomTypeId: `BAD-${runId}`, ratePlan: "QAOTA", externalRatePlanId: `BADRATE-${runId}` });
  response = await action("replay_channel_message", { messageId: failedMessage.id });
  assert.equal(response.json.integrations.inbound.find((item) => item.id === failedMessage.id).status, "PROCESSED");
  record("채널 연결·매핑·ARI·NEW/MODIFY/CANCEL·멱등·DLQ 재처리");

  data = response.json;
  const pendingEvent = data.integrations.outbox.find((item) => item.status === "PENDING");
  assert.ok(pendingEvent);
  response = await action("dispatch_outbox_event", { eventId: pendingEvent.id, outcome: "FAIL", provider: "QA_WEBHOOK" });
  assert.equal(response.json.integrations.outbox.find((item) => item.id === pendingEvent.id).status, "FAILED");
  response = await action("dispatch_outbox_event", { eventId: pendingEvent.id, outcome: "ACK", provider: "QA_WEBHOOK" });
  assert.equal(response.json.integrations.outbox.find((item) => item.id === pendingEvent.id).status, "PUBLISHED");
  record("Transactional Outbox 장애 주입·재전송");

  // An expected 409 is a positive control: the audit must refuse to close while
  // operational blockers created by this workflow still exist.
  response = await action("run_night_audit", {}, { expectStatus: 409 });
  assert.ok(Array.isArray(response.json.blockers));
  record("야간 감사 선행조건·차단 UI", "의도된 409 확인");

  data = (await snapshot()).data;
  if (data.controls.openCashier) {
    response = await action("close_cashier", { countedAmount: String(data.controls.openCashier.opening_amount || 0) });
    assert.equal(response.json.controls.openCashier, null);
  }
  record("캐셔 마감·차이 기록");

  // Search for the principal that actually executed this run. Production-like
  // staging uses a verified QA Auth user, while local runs may use the demo email.
  const auditActor=process.env.PMS_TEST_EMAIL||process.env.PMS_DEMO_USER_EMAIL||"";
  const finalReports = await request(`/api/pms?${new URLSearchParams({ view: "report", report: "audit", from: businessDate, to: addDays(businessDate, 30), q: auditActor, page: "1", pageSize: "100" })}`);
  assert.equal(finalReports.response.status, 200);
  assert.ok(finalReports.json.pagination.total > 0);
  record("감사 로그 키워드 추적", `${finalReports.json.pagination.total}건`);

  console.log(`\nAurora PMS full workflow QA passed: ${results.length} checkpoints · run ${runId}`);
}

main().catch((error) => {
  console.error(`\nQA FAILED (${runId}):`, error.stack || error);
  process.exitCode = 1;
});
