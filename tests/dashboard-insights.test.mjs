/** Behavioral checks that prevent fabricated dashboard guidance from returning. */
import test from "node:test";
import assert from "node:assert/strict";
import { dashboardInsight } from "../app/dashboard-insights.ts";

test("dashboard insight derives peak arrival and operational counts from facts", () => {
  const insight = dashboardInsight([
    { arrival_date:"2031-04-01",status:"DUE_IN",eta:"15:10:00",room_number:null },
    { arrival_date:"2031-04-01",status:"DUE_IN",eta:"16:20:00",room_number:"501" },
    { arrival_date:"2031-04-02",status:"DUE_IN",eta:"15:30:00",room_number:null },
  ],[
    { housekeeping_status:"DIRTY" },
    { housekeeping_status:"CLEAN" },
  ],"2031-04-01");
  assert.match(insight.message,/도착 2건 중 미배정 1건/u);
  assert.match(insight.message,/15:00–17:00.*2건/u);
  assert.match(insight.message,/청소 필요 객실 1실/u);
  assert.equal(insight.workspace,"rooms");
});

test("dashboard insight reports an evidence-backed empty arrival state", () => {
  const insight=dashboardInsight([],[],"2031-04-01");
  assert.match(insight.message,/도착 예정 예약이 없습니다/u);
  assert.equal(insight.workspace,"frontdesk");
});
