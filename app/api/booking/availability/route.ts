/** Public read-only availability HTTP contract. */
import type { NextRequest } from "next/server";
import { allowBookingRequest, publicBookingError } from "../guard";
import { rateLimitHeaders } from "../../rate-limit";
import { BookingError, getAvailability } from "../service";
import { resolvePublicPropertyForRequest } from "../property-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const rateLimit=await allowBookingRequest(request,"read");
    if (!rateLimit.allowed) return Response.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store", ...rateLimitHeaders(rateLimit) } });
    const property=await resolvePublicPropertyForRequest(request);
    if(!property)return Response.json({error:"예약 사이트를 찾을 수 없습니다.",code:"PROPERTY_NOT_FOUND"},{status:404,headers:{"Cache-Control":"no-store"}});
    const query = request.nextUrl.searchParams;
    const availability = await getAvailability({
      arrival: query.get("arrival") || "",
      departure: query.get("departure") || "",
      adults: query.get("adults") || "1",
      children: query.get("children") || "0",
    },property.propertyId);
    return Response.json(availability, { headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
  } catch (error) {
    if (error instanceof BookingError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return publicBookingError(error);
  }
}
