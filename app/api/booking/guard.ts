import type { NextRequest } from "next/server";

const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export function allowBookingRequest(request: NextRequest, kind: "read" | "write") {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = kind === "read" ? 60 : 10;
  const key = `${kind}:${clientAddress(request)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 2_000) for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function isSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export function publicBookingError(error: unknown) {
  const errorId = crypto.randomUUID();
  console.error("[AURORA_BOOKING_ERROR]", { errorId, message: error instanceof Error ? error.message : String(error) });
  return Response.json({ error: "예약 처리 중 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", code: "BOOKING_UNAVAILABLE", errorId }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
