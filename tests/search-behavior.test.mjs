/** Behavioral contracts for user-facing search normalization and SQL safety. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeSqlLike,
  matchesSearch,
  normalizeSearchCompact,
  normalizeSearchText,
  personSearchText,
  sqlCompactPattern,
  sqlLikePattern,
} from "../lib/search.ts";
import { resolveFocusedRow } from "../lib/focus-result.ts";

test("search normalization handles Korean spacing, width and phone punctuation", () => {
  assert.equal(normalizeSearchText("  ＡＢＣ   김민지  "), "abc 김민지");
  assert.equal(normalizeSearchCompact("010-2011 8800"), "01020118800");
  assert.equal(personSearchText("민지", "김"), "민지 김 김민지");
  assert.equal(
    matchesSearch(["민지", "김", "010-2011-8800"], "01020118800"),
    true,
  );
});

test("SQL LIKE search treats wildcard input as literal text", () => {
  assert.equal(escapeSqlLike("50%_off\\today"), "50\\%\\_off\\\\today");
  assert.equal(sqlLikePattern("  50%_OFF  "), "%50\\%\\_off%");
  assert.equal(sqlCompactPattern("%%"), "");
});

test("deep-link focus ignores stale placeholder pages and selects the exact row", () => {
  const stale = {
    query: { focus: "" },
    rows: [{ id: "reservation-current" }],
  };
  const focused = {
    query: { focus: "reservation-target" },
    rows: [
      { id: "reservation-other" },
      { id: "reservation-target" },
    ],
  };

  assert.equal(
    resolveFocusedRow(stale, "reservation-target", true),
    undefined,
  );
  assert.equal(
    resolveFocusedRow(stale, "reservation-target", false),
    undefined,
  );
  assert.deepEqual(
    resolveFocusedRow(focused, "reservation-target", false),
    { id: "reservation-target" },
  );
});
