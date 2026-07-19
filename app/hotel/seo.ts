/** Trusted public-site URL and reusable metadata builders for the hotel site. */
import type { Metadata } from "next";
import type { WebsiteContent } from "../api/booking/website-service";
import type { PublicPropertyContext } from "../api/booking/property-resolver";

const PRODUCTION_SITE_URL = "https://aurora-pms-gilt.vercel.app";

function trustedHttpsUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const candidate = new URL(value.includes("://") ? value : `https://${value}`);
    if (candidate.protocol !== "https:" && candidate.protocol !== "http:") return null;
    candidate.pathname = "/";
    candidate.search = "";
    candidate.hash = "";
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Never derives canonical or social URLs from the request Host header. The
 * explicit site URL wins; Vercel's deployment-owned hostname is a safe fallback.
 */
export function publicSiteUrl(hostname?: string) {
  if(hostname){
    const protocol=hostname==="localhost"||hostname==="127.0.0.1"||hostname==="::1"?"http:":"https:";
    return new URL(`${protocol}//${hostname}`);
  }
  return trustedHttpsUrl(process.env.AURORA_PUBLIC_SITE_URL)
    ?? trustedHttpsUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL)
    ?? new URL(PRODUCTION_SITE_URL);
}

function descriptionFor(content: WebsiteContent) {
  const description = `${content.settings.heroSubtitle} ${content.settings.overviewBody}`.replace(/\s+/gu, " ").trim();
  return description.slice(0, 160);
}

export function hotelMetadata(content: WebsiteContent, property?: PublicPropertyContext): Metadata {
  const { settings } = content;
  const title = `${settings.hotelName} | 공식 홈페이지`;
  const description = descriptionFor(content);
  const heroImage = content.hotelMedia.find((item) => item.role === "HERO")?.url
    ?? content.hotelMedia[0]?.url
    ?? "/og.png";
  return {
    metadataBase: publicSiteUrl(property?.hostname),
    title,
    description,
    alternates: { canonical: property?.pathPrefix || "/hotel" },
    robots: { index: content.published, follow: content.published },
    openGraph: {
      type: "website",
      locale: "ko_KR",
      url: property?.pathPrefix || "/hotel",
      siteName: settings.hotelName,
      title,
      description,
      images: [{ url: heroImage, alt: `${settings.hotelName} 대표 이미지` }],
    },
    twitter: { card: "summary_large_image", title, description, images: [heroImage] },
  };
}

export function bookingMetadata(content: WebsiteContent, property?: PublicPropertyContext): Metadata {
  const title = `객실 예약 | ${content.settings.hotelName}`;
  const description = `${content.settings.hotelName}의 실시간 객실 재고와 공식 홈페이지 요금을 확인하고 안전하게 예약하세요.`;
  return {
    metadataBase: publicSiteUrl(property?.hostname),
    title,
    description,
    alternates: { canonical: `${property?.pathPrefix || "/hotel"}/book` },
    // Query-string search combinations are transactional pages, not unique
    // landing pages. Following links is useful; indexing duplicates is not.
    robots: { index: false, follow: true },
    openGraph: { type: "website", locale: "ko_KR", url: `${property?.pathPrefix || "/hotel"}/book`, siteName: content.settings.hotelName, title, description },
  };
}

/** Escapes HTML-significant characters before embedding JSON in a script tag. */
export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

export function hotelStructuredData(content: WebsiteContent, property?: PublicPropertyContext) {
  const base = publicSiteUrl(property?.hostname);
  const prefix=property?.pathPrefix||"/hotel";
  const hotelUrl = new URL(prefix||"/", base).toString();
  const bookingUrl = new URL(`${prefix}/book`, base).toString();
  const images = [...content.hotelMedia, ...content.rooms.flatMap((room) => room.media)].map((item) => item.url);
  return {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": `${hotelUrl}#hotel`,
    name: content.settings.hotelName,
    description: descriptionFor(content),
    url: hotelUrl,
    image: [...new Set(images)],
    telephone: content.settings.phone,
    email: content.settings.email,
    address: { "@type": "PostalAddress", streetAddress: content.settings.address, addressCountry: "KR" },
    checkinTime: content.settings.checkinTime,
    checkoutTime: content.settings.checkoutTime,
    makesOffer: content.rooms.map((room) => ({
      "@type": "Offer",
      url: bookingUrl,
      price: room.baseRate,
      priceCurrency: "KRW",
      availability: "https://schema.org/InStock",
      itemOffered: {
        "@type": "HotelRoom",
        name: room.marketingName,
        description: room.shortDescription,
        occupancy: { "@type": "QuantitativeValue", maxValue: room.capacity },
        amenityFeature: room.amenities.map((name) => ({ "@type": "LocationFeatureSpecification", name, value: true })),
      },
    })),
  };
}
