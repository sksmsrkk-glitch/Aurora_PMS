/** Isolated layout and visual system for the public hotel and booking pages. */
import type { Metadata } from "next";
import { getWebsiteContent } from "../api/booking/website-service";
import { hotelMetadata } from "./seo";
import "./hotel.css";

export async function generateMetadata(): Promise<Metadata> {
  try {
    return hotelMetadata(await getWebsiteContent());
  } catch {
    // Database or unpublished-content failures stay out of search results while
    // the page's normal error/not-found boundary handles the visible response.
    return { title: "Aurora Hotel", robots: { index: false, follow: false } };
  }
}

export default function HotelLayout({ children }: { children: React.ReactNode }) {
  return children;
}
