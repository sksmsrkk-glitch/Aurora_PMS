/** Public read-only availability HTTP contract. */
import type { NextRequest } from "next/server";
import { allowBookingRequest, publicBookingError } from "../guard";
import { BookingError, getAvailability } from "../service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!allowBookingRequest(request, "read")) return Response.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  const query = request.nextUrl.searchParams;
  try {
    const availability = await getAvailability({
      arrival: query.get("arrival") || "",
      departure: query.get("departure") || "",
      adults: query.get("adults") || "1",
      children: query.get("children") || "0",
    });
    return Response.json(availability, { headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
  } catch (error) {
    if (error instanceof BookingError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return publicBookingError(error);
  }
}
