/** Search-engine discovery for the published hotel experience only. */
import type { MetadataRoute } from "next";
import { getWebsiteContent } from "./api/booking/website-service";
import { publicSiteUrl } from "./hotel/seo";

// Publication state is managed in the PMS, so discovery must reflect it without
// waiting for a new frontend deployment.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const content = await getWebsiteContent();
    if (!content.published) return [];
    const base = publicSiteUrl();
    return [
      { url:new URL("/hotel",base).toString(),changeFrequency:"daily",priority:1 },
      { url:new URL("/hotel/book",base).toString(),changeFrequency:"daily",priority:.8 },
    ];
  } catch {
    return [];
  }
}
