/** Public booking rate limits, payload limits and same-origin protections. */
import type { NextRequest } from "next/server";
import { consumeRateLimit } from "../rate-limit";

export function allowBookingRequest(request: NextRequest, kind: "read" | "write") {
  return consumeRateLimit(request,`booking-${kind}`,kind === "read" ? 60 : 10,60_000);
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
