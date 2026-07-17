/** Keep authenticated PMS and API surfaces out of public search indexes. */
import type { MetadataRoute } from "next";
import { publicSiteUrl } from "./hotel/seo";

export default function robots(): MetadataRoute.Robots {
  const base = publicSiteUrl();
  return {
    rules:{
      userAgent:"*",
      allow:["/hotel","/hotel/"],
      disallow:["/api/","/login","/overview","/frontdesk","/inventory","/website","/groups","/finance","/accounting","/channels","/rooms","/reports","/master","/revenue","/audit"],
    },
    sitemap:new URL("/sitemap.xml",base).toString(),
    host:base.origin,
  };
}
