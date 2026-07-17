/** Suspense boundary for URL-driven direct-booking interactions. */
import type { Metadata } from "next";
import { Suspense } from "react";
import { getWebsiteContent } from "../../api/booking/website-service";
import { bookingMetadata } from "../seo";
import BookingClient from "./BookingClient";

// Availability, CMS metadata, and publication state are runtime hotel data and
// must not be frozen into the artifact created by `next build`.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  try { return bookingMetadata(await getWebsiteContent()); }
  catch { return { title:"객실 예약 | Aurora Hotel", robots:{index:false,follow:false} }; }
}

export default function BookingPage() {
  return <Suspense fallback={<main className="booking-page"><div className="booking-loading">예약 가능 객실을 준비하고 있습니다.</div></main>}><BookingClient/></Suspense>;
}
