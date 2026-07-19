/** Search-engine discovery for the published hotel experience only. */
import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { getCachedWebsiteContent } from "./hotel/content";
import { publicSiteUrl } from "./hotel/seo";
import { resolvePublicPropertyForRequest } from "./api/booking/property-resolver";

// Publication changes reach crawlers within one minute without regenerating the
// sitemap on every request.
export const revalidate = 60;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    // Avoid freezing an empty sitemap when application build precedes the
    // matching database migration. CMS content remains cached for 60 seconds.
    await connection();
    const property=await resolvePublicPropertyForRequest({headers:await headers()});
    if(!property)return [];
    const content = await getCachedWebsiteContent(property.propertyId);
    if (!content.published) return [];
    const base = publicSiteUrl(property.hostname),prefix=property.pathPrefix;
    return [
      { url:new URL(prefix||"/",base).toString(),changeFrequency:"daily",priority:1 },
      { url:new URL(`${prefix}/book`,base).toString(),changeFrequency:"daily",priority:.8 },
    ];
  } catch {
    return [];
  }
}
