/**
 * Presents the public hotel site at the root of verified custom domains while
 * keeping the shared Vercel/platform host rooted at the authenticated PMS.
 * Database-backed domain validation still happens in the destination page/API;
 * this proxy only provides clean URLs and never selects a tenant itself.
 */
import { NextResponse, type NextRequest } from "next/server";

function cleanHost(value: string | null) {
  return (value || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/u, "")
    .replace(/\.$/u, "");
}

export function proxy(request: NextRequest) {
  const host = cleanHost(
    process.env.VERCEL === "1"
      ? request.headers.get("x-forwarded-host")
      : request.headers.get("host"),
  );
  const platformHosts = new Set(
    [
      ...(process.env.AURORA_PLATFORM_HOSTS || "").split(","),
      process.env.VERCEL_PROJECT_PRODUCTION_URL || "",
      process.env.VERCEL_URL || "",
      "localhost",
    ]
      .map(cleanHost)
      .filter(Boolean),
  );
  if (platformHosts.has(host)) return NextResponse.next();
  const path = request.nextUrl.pathname;
  if (path !== "/" && path !== "/book") return NextResponse.next();
  const destination = request.nextUrl.clone();
  destination.pathname = path === "/" ? "/hotel" : "/hotel/book";
  return NextResponse.rewrite(destination);
}

export const config = { matcher: ["/", "/book"] };
