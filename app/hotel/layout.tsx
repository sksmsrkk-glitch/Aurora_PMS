/** Isolated layout and visual system for the public hotel and booking pages. */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getCachedWebsiteContent } from "./content";
import { hotelMetadata } from "./seo";
import { resolvePublicPropertyForRequest } from "../api/booking/property-resolver";
import "./hotel.css";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const property=await resolvePublicPropertyForRequest({headers:await headers()});
    if(!property)throw new Error("Unknown public hotel domain");
    return hotelMetadata(await getCachedWebsiteContent(property.propertyId),property);
  } catch {
    // Database or unpublished-content failures stay out of search results while
    // the page's normal error/not-found boundary handles the visible response.
    return { title: "Aurora Hotel", robots: { index: false, follow: false } };
  }
}

export default function HotelLayout({ children }: { children: React.ReactNode }) {
  return children;
}
