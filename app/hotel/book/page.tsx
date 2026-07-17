/** Suspense boundary for URL-driven direct-booking interactions. */
import { Suspense } from "react";
import BookingClient from "./BookingClient";

export default function BookingPage() {
  return <Suspense fallback={<main className="booking-page"><div className="booking-loading">예약 가능 객실을 준비하고 있습니다.</div></main>}><BookingClient/></Suspense>;
}
