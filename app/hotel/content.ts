/** One-minute CMS projection cache shared by hotel pages, metadata and sitemap. */
import { unstable_cache } from "next/cache";
import { getWebsiteContent } from "../api/booking/website-service";

export const getCachedWebsiteContent = unstable_cache(
  getWebsiteContent,
  ["aurora-public-website-content"],
  { revalidate: 60, tags: ["aurora-public-website-content"] },
);
