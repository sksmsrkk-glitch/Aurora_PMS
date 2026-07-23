/** Behavioral coverage for every client-side PMS search document. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  arInvoiceMatchesSearch,
  businessBlockMatchesSearch,
  channelCatalogMatchesSearch,
  folioWindowMatchesSearch,
  inventoryRoomTypeMatchesSearch,
  occupancyRoomsForSearch,
  reservationOfferMatchesSearch,
  roomMatchesSearch,
  salesAccountMatchesSearch,
  staffUserMatchesSearch,
  websiteRoomMatchesSearch,
} from "../lib/pms-search.ts";

test("room and inventory search accept width, punctuation and Korean initials", () => {
  const room = {
    number: "101",
    room_type_code: "DLX",
    room_type_name: "디럭스 킹",
    floor: 1,
    assignee: "김하우스",
    front_desk_status: "VACANT",
    housekeeping_status: "INSPECTED",
  };
  const labels = { VACANT: "공실", INSPECTED: "점검 완료" };

  assert.equal(roomMatchesSearch(room, "１０１", labels), true);
  assert.equal(roomMatchesSearch(room, "ㄷㄹㅅ", labels), true);
  assert.equal(roomMatchesSearch(room, "점검완료", labels), true);
  assert.equal(
    inventoryRoomTypeMatchesSearch(
      { code: "DLX", name: "디럭스 킹" },
      "ＤＬＸ",
    ),
    true,
  );
});

test("group and sales-account search use one normalized contract", () => {
  const block = {
    code: "BMW4JI21S",
    name: "QA 블록",
    status: "CUTOFF",
    account_name: "올마이투어",
    group_name: "",
    arrival_date: "2026-07-19",
    departure_date: "2026-07-21",
  };
  const account = {
    name: "QA 컴퍼니",
    type: "COMPANY",
    external_id: "CO-MW4JI21S",
    credit_status: "DIRECT_BILL",
  };

  assert.equal(businessBlockMatchesSearch(block, "ｂｍｗ４ｊｉ２１ｓ"), true);
  assert.equal(businessBlockMatchesSearch(block, "2026 07 19"), true);
  assert.equal(salesAccountMatchesSearch(account, "co mw4ji21s"), true);
  assert.equal(salesAccountMatchesSearch(account, "direct bill"), true);
});

test("finance search accepts natural Korean name order and formatted ids", () => {
  const folio = {
    name: "Guest Folio",
    guest_name: "민지 김",
    confirmation_no: "SEL-260716-0184",
    status: "OPEN",
    window_no: 1,
  };
  const invoice = {
    invoice_no: "AR-20260716-8542",
    account_name: "올마이투어",
    status: "OPEN",
    due_date: "2026-08-15",
  };

  assert.equal(folioWindowMatchesSearch(folio, "김민지"), true);
  assert.equal(folioWindowMatchesSearch(folio, "김 민지"), true);
  assert.equal(folioWindowMatchesSearch(folio, "ＳＥＬ２６０７１６０１８４"), true);
  assert.equal(arInvoiceMatchesSearch(invoice, "ar202607168542"), true);
});

test("channel, website and staff search normalize every visible alias", () => {
  const channel = {
    display_name: "부킹닷컴",
    provider_code: "BOOKING_COM",
    description: "Booking.com ARI 예약 연동",
    supplier_name: "Booking Holdings",
  };
  const room = {
    code: "STE",
    name: "시티 스위트",
    marketing_name: "City Aurora Suite",
    published: true,
  };
  const staff = {
    display_name: "민지 김",
    email: "PMS@ALLMYTOUR.COM",
  };

  assert.equal(channelCatalogMatchesSearch(channel, "ＢＯＯＫＩＮＧ．ＣＯＭ"), true);
  assert.equal(channelCatalogMatchesSearch(channel, "booking com"), true);
  assert.equal(websiteRoomMatchesSearch(room, "ㅅㅌ ㅅㅇㅌ"), true);
  assert.equal(websiteRoomMatchesSearch(room, "홈페이지 공개"), true);
  assert.equal(staffUserMatchesSearch(staff, "프로퍼티 관리자", "김민지"), true);
  assert.equal(
    staffUserMatchesSearch(staff, "프로퍼티 관리자", "pms allmytour com"),
    true,
  );
});

test("reservation offer search covers room and every rate-plan alias", () => {
  const offer = {
    code: "DLX",
    name: "디럭스 킹",
    plans: [
      { code: "BAR", name: "베스트 가용 요금" },
      { code: "PKG-BF", name: "조식 패키지" },
    ],
  };

  assert.equal(reservationOfferMatchesSearch(offer, "ＤＬＸ"), true);
  assert.equal(reservationOfferMatchesSearch(offer, "ㅈㅅ ㅍㅋㅈ"), true);
  assert.equal(reservationOfferMatchesSearch(offer, "pkg bf"), true);
  assert.equal(reservationOfferMatchesSearch(offer, "NO_MATCH"), false);
});

test("occupancy search hides unrelated rooms and preserves vacant type rows", () => {
  const rooms = [
    { id: "room-101", room_type_id: "DLX" },
    { id: "room-102", room_type_id: "DLX" },
    { id: "room-201", room_type_id: "STE" },
  ];

  assert.deepEqual(
    occupancyRoomsForSearch(rooms, [{ room_id: "room-101" }], {
      query: "김민지",
      source: "",
      ratePlan: "",
      roomTypeId: "",
    }),
    [rooms[0]],
  );
  assert.deepEqual(
    occupancyRoomsForSearch(rooms, [{ room_id: null }], {
      query: "David",
      source: "",
      ratePlan: "",
      roomTypeId: "",
    }),
    [],
  );
  assert.deepEqual(
    occupancyRoomsForSearch(rooms, [], {
      query: "",
      source: "",
      ratePlan: "",
      roomTypeId: "DLX",
    }),
    [rooms[0], rooms[1]],
  );
});
