/** Behavioral contracts for user-facing search normalization and SQL safety. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeSqlLike,
  koreanInitialSearchText,
  matchesSearch,
  normalizeSearchCompact,
  normalizeSearchText,
  personDisplaySearchText,
  personSearchText,
  sqlCompactPattern,
  sqlLikePattern,
} from "../lib/search.ts";
import {
  englishKeysToHangul,
  hangulToEnglishKeys,
  keyboardSearchAlternates,
} from "../lib/korean-keyboard.ts";
import { classifySearchQuality } from "../app/api/pms/search-quality.ts";
import { classifySearchHealth } from "../lib/search-quality-health.ts";
import { resolveFocusedRow } from "../lib/focus-result.ts";
import {
  parseSearchHistory,
  SEARCH_HISTORY_TTL_MS,
  updateSearchHistory,
} from "../lib/search-history.ts";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchPropertyFingerprint,
  searchQueryFingerprint,
} from "../lib/search-cursor.ts";
import { mergeSearchPage } from "../lib/search-pagination.ts";

test("search normalization handles Korean spacing, width and phone punctuation", () => {
  assert.equal(normalizeSearchText("  ＡＢＣ   김민지  "), "abc 김민지");
  assert.equal(normalizeSearchCompact("010-2011 8800"), "01020118800");
  assert.equal(personSearchText("민지", "김"), "민지 김 김민지");
  assert.equal(personDisplaySearchText("민지 김"), "민지 김 민지김 김민지");
  assert.equal(koreanInitialSearchText("디럭스 킹"), "ㄷㄹㅅ ㅋ");
  assert.equal(
    matchesSearch(["민지", "김", "010-2011-8800"], "01020118800"),
    true,
  );
  assert.equal(matchesSearch(["디럭스 킹"], "ㄷㄹㅅ"), true);
  assert.equal(matchesSearch(["프리미어 트윈 103"], "103 ㅍㄹㅁㅇ"), true);
});

test("SQL LIKE search treats wildcard input as literal text", () => {
  assert.equal(escapeSqlLike("50%_off\\today"), "50\\%\\_off\\\\today");
  assert.equal(sqlLikePattern("  50%_OFF  "), "%50\\%\\_off%");
  assert.equal(sqlCompactPattern("%%"), "");
});

test("Korean two-set keyboard correction is conservative and reversible", () => {
  assert.equal(englishKeysToHangul("rlaalswl"), "김민지");
  assert.equal(englishKeysToHangul("dkssud"), "안녕");
  assert.equal(hangulToEnglishKeys("김민지"), "rlaalswl");
  assert.deepEqual(keyboardSearchAlternates("rlaalswl"), ["김민지"]);
  assert.deepEqual(keyboardSearchAlternates("김민지"), ["rlaalswl"]);
  assert.deepEqual(
    keyboardSearchAlternates("Sofia"),
    [],
    "ordinary English names must keep their original meaning",
  );
});

test("search quality telemetry exposes only coarse non-PII dimensions", () => {
  const dimensions = classifySearchQuality({
    query: "김민지 010",
    total: 0,
    truncated: false,
    correctionApplied: true,
    latencyMs: 900,
  });
  assert.deepEqual(dimensions, {
    queryLengthBucket: 8,
    queryScript: "MIXED",
    correctionUsed: true,
    resultBucket: "ZERO",
    latencyBucket: "SLOW",
    zeroResult: true,
  });
  assert.equal("query" in dimensions, false);
  assert.equal("queryHash" in dimensions, false);
  assert.equal("userId" in dimensions, false);
});

test("search quality alerts require enough volume and use stable thresholds", () => {
  const learning = classifySearchHealth({
    event_date: "2026-07-23",
    searches: 1,
    zero_results: 1,
    slow_searches: 1,
    correction_searches: 0,
  });
  assert.equal(learning.health, "LEARNING");

  const healthy = classifySearchHealth({
    event_date: "2026-07-23",
    searches: 20,
    zero_results: 2,
    slow_searches: 1,
    correction_searches: 3,
  });
  assert.equal(healthy.health, "HEALTHY");
  assert.equal(healthy.zero_rate, 10);
  assert.equal(healthy.correction_rate, 15);

  const watch = classifySearchHealth({
    event_date: "2026-07-23",
    searches: 10,
    zero_results: 3,
    slow_searches: 0,
    correction_searches: 0,
  });
  assert.equal(watch.health, "WATCH");

  const critical = classifySearchHealth({
    event_date: "2026-07-23",
    searches: 20,
    zero_results: 1,
    slow_searches: 5,
    correction_searches: 0,
  });
  assert.equal(critical.health, "CRITICAL");
  assert.match(critical.recommendation, /DB 지연/u);
});

test("recent search history is bounded, frequency-ranked, and expires", () => {
  const now = Date.parse("2026-07-23T01:00:00Z");
  const sofia = {
    id: "reservation-sofia",
    kind: "RESERVATION",
    title: "Sofia Martinez",
    subtitle: "SEL-260716-01",
    meta: "미배정",
    path: "/frontdesk?focus=reservation-sofia",
  };
  const room = {
    id: "room-101",
    kind: "ROOM",
    title: "101호 · 디럭스",
    subtitle: "DLX · VACANT",
    meta: "INSPECTED",
    path: "/rooms?focus=room-101",
  };
  let history = updateSearchHistory([], sofia, now - 20);
  history = updateSearchHistory(history, room, now - 10);
  history = updateSearchHistory(history, sofia, now);
  assert.equal(history[0].id, sofia.id);
  assert.equal(history[0].selectionCount, 2);
  assert.equal(parseSearchHistory(JSON.stringify(history), now).length, 2);
  assert.deepEqual(
    parseSearchHistory(
      JSON.stringify([
        {
          ...history[0],
          lastSelectedAt: now - SEARCH_HISTORY_TTL_MS - 1,
        },
      ]),
      now,
    ),
    [],
  );
  assert.deepEqual(
    parseSearchHistory(
      JSON.stringify([{ ...history[0], path: "https://attacker.invalid" }]),
      now,
    ),
    [],
  );
  assert.equal(JSON.stringify(history).includes('"query"'), false);
});

test("search cursor is opaque, query-bound, and rejects malformed input", () => {
  const previousSecret = process.env.SEARCH_CURSOR_SECRET;
  try {
    process.env.SEARCH_CURSOR_SECRET =
      "unit-test-search-cursor-secret-with-32-characters";
    const queryFingerprint = searchQueryFingerprint("김민지");
    const propertyFingerprint = searchPropertyFingerprint("prop-seoul");
    const encoded = encodeSearchCursor({
      v: 2,
      kind: "reservations",
      anchor: "2026-07-23T01:00:00.000Z",
      rank: 800,
      sortAt: "2026-07-22T09:00:00.000Z",
      id: "reservation-001",
      queryFingerprint,
      propertyFingerprint,
    });
    assert.equal(encoded.includes("김민지"), false);
    assert.equal(
      decodeSearchCursor(
        encoded,
        "reservations",
        queryFingerprint,
        propertyFingerprint,
      )?.id,
      "reservation-001",
    );
    assert.equal(
      decodeSearchCursor(
        encoded,
        "rooms",
        queryFingerprint,
        propertyFingerprint,
      ),
      null,
    );
    assert.equal(
      decodeSearchCursor(
        encoded,
        "reservations",
        searchQueryFingerprint("다른 검색어"),
        propertyFingerprint,
      ),
      null,
    );
    assert.equal(
      decodeSearchCursor(
        encoded,
        "reservations",
        queryFingerprint,
        searchPropertyFingerprint("prop-busan"),
      ),
      null,
    );
    const [payload, signature] = encoded.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        id: "reservation-forged",
      }),
      "utf8",
    ).toString("base64url");
    assert.equal(
      decodeSearchCursor(
        `${forgedPayload}.${signature}`,
        "reservations",
        queryFingerprint,
        propertyFingerprint,
      ),
      null,
      "changing a valid payload without the server secret must fail",
    );
    assert.equal(
      decodeSearchCursor(
        "../invalid",
        "reservations",
        queryFingerprint,
        propertyFingerprint,
      ),
      null,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.SEARCH_CURSOR_SECRET;
    else process.env.SEARCH_CURSOR_SECRET = previousSecret;
  }
});

test("search cursor fails closed without a production signing secret", () => {
  const previousCursorSecret = process.env.SEARCH_CURSOR_SECRET;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.SEARCH_CURSOR_SECRET;
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = "production";
    assert.throws(
      () =>
        encodeSearchCursor({
          v: 2,
          kind: "rooms",
          anchor: "2026-07-23T01:00:00.000Z",
          rank: 800,
          sortAt: "2026-07-22T09:00:00.000Z",
          id: "room-101",
          queryFingerprint: searchQueryFingerprint("101"),
          propertyFingerprint: searchPropertyFingerprint("prop-seoul"),
        }),
      /at least 32 characters/u,
    );
  } finally {
    if (previousCursorSecret === undefined)
      delete process.env.SEARCH_CURSOR_SECRET;
    else process.env.SEARCH_CURSOR_SECRET = previousCursorSecret;
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousAuthSecret;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("search keyset pages merge without duplicate options and close at EOF", () => {
  const first = [
    {
      id: "reservations",
      label: "예약·고객",
      nextCursor: "page-2",
      items: [
        { id: "r1", kind: "RESERVATION" },
        { id: "r2", kind: "RESERVATION" },
      ],
    },
    {
      id: "rooms",
      label: "객실",
      items: [{ id: "room-101", kind: "ROOM" }],
    },
  ];
  const merged = mergeSearchPage(first, {
    id: "reservations",
    label: "예약·고객",
    items: [
      { id: "r2", kind: "RESERVATION" },
      { id: "r3", kind: "RESERVATION" },
    ],
  });
  assert.deepEqual(
    merged[0].items.map((item) => item.id),
    ["r1", "r2", "r3"],
  );
  assert.equal(merged[0].nextCursor, undefined);
  assert.deepEqual(merged[1], first[1]);
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
