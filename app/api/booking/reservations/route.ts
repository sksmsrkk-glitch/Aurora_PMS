/** Public create/cancel booking HTTP contract with sanitized errors. */
import type { NextRequest } from "next/server";
import { allowBookingRequest, isSameOrigin, publicBookingError } from "../guard";
import { BookingError, cancelWebReservation, createWebReservation, findWebReservationByIdempotency, type ReservationInput } from "../service";
import { rateLimitHeaders } from "../../rate-limit";
import { resolvePublicPropertyForRequest } from "../property-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function rejectedRequest(request: NextRequest) {
  if (!isSameOrigin(request)) return Response.json({ error: "허용되지 않은 요청입니다.", code: "ORIGIN_REJECTED" }, { status: 403 });
  const rateLimit=await allowBookingRequest(request,"write");
  if (!rateLimit.allowed) return Response.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", code: "RATE_LIMITED" }, { status: 429, headers: rateLimitHeaders(rateLimit) });
  return null;
}

async function jsonBody(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16_384) throw new BookingError("요청 크기가 너무 큽니다.", 413, "PAYLOAD_TOO_LARGE");
  try { return await request.json() as Record<string, unknown>; } catch { throw new BookingError("요청 형식을 확인해 주세요.", 400, "INVALID_JSON"); }
}

export async function POST(request: NextRequest) {
  let rejected:Response|null;
  try { rejected=await rejectedRequest(request); } catch(error) { return publicBookingError(error); }
  if (rejected) return rejected;
  const idempotencyKey = request.headers.get("idempotency-key") || "";
  if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(idempotencyKey)) return Response.json({ error: "안전한 예약 처리를 위해 예약 요청 키가 필요합니다.", code: "IDEMPOTENCY_REQUIRED" }, { status: 400 });
  try {
    const property=await resolvePublicPropertyForRequest(request);
    if(!property)return Response.json({error:"예약 사이트를 찾을 수 없습니다.",code:"PROPERTY_NOT_FOUND"},{status:404});
    const result = await createWebReservation(await jsonBody(request) as ReservationInput, idempotencyKey,property.propertyId);
    return Response.json(result, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BookingError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("booking_request_idempotency_uq") || message.includes("booking_requests_property_idempotency")) {
      const property=await resolvePublicPropertyForRequest(request);
      const existing = property ? await findWebReservationByIdempotency(idempotencyKey,property.propertyId) : null;
      if (existing) return Response.json(existing, { headers: { "Cache-Control": "no-store" } });
    }
    if (message.includes("room type sold out") || message.includes("room type closed")) return Response.json({ error: "선택한 객실이 방금 판매 완료되었습니다. 다시 검색해 주세요.", code: "SOLD_OUT" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    return publicBookingError(error);
  }
}

export async function DELETE(request: NextRequest) {
  let rejected:Response|null;
  try { rejected=await rejectedRequest(request); } catch(error) { return publicBookingError(error); }
  if (rejected) return rejected;
  try {
    const property=await resolvePublicPropertyForRequest(request);
    if(!property)return Response.json({error:"예약 사이트를 찾을 수 없습니다.",code:"PROPERTY_NOT_FOUND"},{status:404});
    const result = await cancelWebReservation(await jsonBody(request),property.propertyId);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BookingError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("reservation_transition_from_uq")) return Response.json({ error: "예약 상태가 이미 변경되었습니다. 예약 정보를 다시 확인해 주세요.", code: "STATE_CHANGED" }, { status: 409 });
    return publicBookingError(error);
  }
}
