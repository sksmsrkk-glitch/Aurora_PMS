/** Suspense boundary for URL-driven direct-booking interactions. */
import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { getCachedWebsiteContent } from "../content";
import { bookingMetadata } from "../seo";
import BookingClient from "./BookingClient";
import { resolvePublicPropertyForRequest } from "../../api/booking/property-resolver";

// Search parameters remain request-specific in the client; only published CMS
// metadata is cached, with the same one-minute freshness as the hotel landing.
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  try {
    const property=await resolvePublicPropertyForRequest({headers:await headers()});
    if(!property)throw new Error("Unknown public hotel domain");
    return bookingMetadata(await getCachedWebsiteContent(property.propertyId),property);
  }
  catch { return { title:"객실 예약 | Aurora Hotel", robots:{index:false,follow:false} }; }
}

export default async function BookingPage() {
  // Defer CMS-backed metadata and page generation until the deployed database
  // has been promoted; the shared CMS projection still revalidates every minute.
  await connection();
  const property=await resolvePublicPropertyForRequest({headers:await headers()});
  if(!property)return <main className="booking-page"><div className="booking-loading">예약 사이트를 찾을 수 없습니다.</div></main>;
  return <Suspense fallback={<main className="booking-page"><div className="booking-loading">예약 가능 객실을 준비하고 있습니다.</div></main>}><BookingClient/></Suspense>;
}
