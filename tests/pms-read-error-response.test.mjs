import assert from "node:assert/strict";
import test from "node:test";
import {
  PmsReadError,
  pmsReadFailureResponse,
} from "../app/api/pms/frontdesk-read.ts";

test("expected PMS read failures retain their client status and no-store policy", async () => {
  const response = pmsReadFailureResponse(
    new PmsReadError("검색 커서가 올바르지 않습니다.", 400),
    "fallback",
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: "검색 커서가 올바르지 않습니다.",
  });
});

test("unexpected PMS read failures stay opaque and report a server failure", async () => {
  const response = pmsReadFailureResponse(
    new Error("database credential must never leak"),
    "검색을 완료하지 못했습니다.",
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "검색을 완료하지 못했습니다.",
  });
});
