/** Behavioral release contracts for the six-stage hotel-operator redesign. */
import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_ACCESS_TEMPLATES } from "../app/access-control.ts";
import { navigationGroupsFor, primaryNavigationFor } from "../app/pms-navigation.ts";
import { parseFrontdeskQuery, PmsReadError } from "../app/api/pms/frontdesk-read.ts";
import { boundedCalendarWindow, inclusiveDays, matchingDayCount } from "../app/inventory-window.ts";

test("role navigation exposes only authorized workspaces in job-first order", () => {
  const housekeeping = navigationGroupsFor("HOUSEKEEPING", ROLE_ACCESS_TEMPLATES.HOUSEKEEPING.permissions);
  assert.deepEqual(housekeeping.flatMap((group) => group.items.map((item) => item.workspace)), ["overview", "rooms"]);
  assert.equal(housekeeping[0].label, "오늘 운영");

  const accountant = primaryNavigationFor("ACCOUNTANT", ROLE_ACCESS_TEMPLATES.ACCOUNTANT.permissions);
  assert.deepEqual(accountant.map((item) => item.workspace), ["overview", "finance", "accounting", "reports"]);
  assert.ok(accountant.every((item) => ROLE_ACCESS_TEMPLATES.ACCOUNTANT.permissions[item.workspace] !== "NONE"));
});

test("frontdesk URL input is closed, bounded, and rejects reversed dates", () => {
  const parsed = parseFrontdeskQuery(new URLSearchParams({
    queue: "UNKNOWN", status: "ROOT", assignment: "MAYBE", balance: "DUE",
    sort: "updated", page: "999999", pageSize: "500", q: `  ${"x".repeat(200)}  `,
  }));
  assert.equal(parsed.queue, "TODAY");
  assert.equal(parsed.status, "");
  assert.equal(parsed.assignment, "ALL");
  assert.equal(parsed.balance, "DUE");
  assert.equal(parsed.sort, "updated");
  assert.equal(parsed.page, 10_000);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.q.length, 120);
  assert.throws(
    () => parseFrontdeskQuery(new URLSearchParams({ from: "2026-08-02", to: "2026-08-01" })),
    (error) => error instanceof PmsReadError && error.status === 400,
  );
});

test("long inventory selections always render a bounded read window", () => {
  assert.equal(inclusiveDays("2026-01-01", "2026-12-31"), 365);
  assert.deepEqual(boundedCalendarWindow("2026-01-01", "2026-12-31", 14), {
    from: "2026-01-01", to: "2026-01-14", days: 14,
  });
  assert.deepEqual(boundedCalendarWindow("2026-12-25", "2026-12-31", 30), {
    from: "2026-12-25", to: "2026-12-31", days: 7,
  });
  assert.equal(matchingDayCount("2026-07-01", "2026-07-31", [1, 2, 3, 4, 5]), 23);
});
