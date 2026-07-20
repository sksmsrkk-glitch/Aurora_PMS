/**
 * Server-only hostname to hotel resolver for the multi-tenant public site.
 *
 * A browser can choose a hostname but can never submit a property id. Only an
 * ACTIVE domain row owned by an ACTIVE organization/property establishes the
 * tenant scope. Development fallback is deliberately disabled in production.
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { getPmsDatabase } from "../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../db/schema-contract";

export type PublicPropertyContext = {
  propertyId: string;
  propertySlug: string;
  organizationId: string;
  hostname: string;
  pathPrefix: "" | "/hotel";
};

const rootDatabase = () =>
  getPmsDatabase({ DATABASE_URL: process.env.DATABASE_URL });

function normalizedHostname(value: string | null | undefined) {
  const candidate = (value || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "");
  // URL parsing safely removes an optional development port and rejects userinfo.
  try {
    const hostname = new URL(`http://${candidate}`).hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    )
      return hostname;
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      hostname,
    )
      ? hostname
      : null;
  } catch {
    return null;
  }
}

function platformHosts() {
  const configured = [
    ...(process.env.AURORA_PLATFORM_HOSTS || "").split(","),
    process.env.VERCEL_PROJECT_PRODUCTION_URL || "",
    process.env.VERCEL_URL || "",
  ];
  return new Set(
    configured
      .map((host) => normalizedHostname(host))
      .filter((host): host is string => Boolean(host)),
  );
}

/** Host is taken from infrastructure-owned forwarding metadata on Vercel. */
export function trustedRequestHostname(request: Pick<Request, "headers">) {
  const forwarded =
    process.env.VERCEL === "1" ? request.headers.get("x-forwarded-host") : null;
  return normalizedHostname(forwarded || request.headers.get("host"));
}

const resolveActiveDomain = unstable_cache(
  async (hostname: string) => {
    const db = rootDatabase();
    await verifyPmsSchemaContract(db);
    return db.resolvePublicProperty(hostname);
  },
  ["aurora-public-property-domain-v2"],
  { revalidate: 60 },
);

export async function resolvePublicPropertyForHost(
  hostnameValue: string | null | undefined,
): Promise<PublicPropertyContext | null> {
  const hostname = normalizedHostname(hostnameValue);
  if (!hostname) return null;
  const local =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const resolved = local ? null : await resolveActiveDomain(hostname);
  if (resolved) {
    return {
      propertyId: resolved.property_id,
      propertySlug: resolved.property_slug,
      organizationId: resolved.organization_id,
      hostname,
      pathPrefix: platformHosts().has(hostname) ? "/hotel" : "",
    };
  }
  // Local and preview environments remain usable without weakening production
  // domain isolation. An explicit override is still required outside localhost.
  const fallbackAllowed =
    process.env.NODE_ENV !== "production" &&
    (local || process.env.AURORA_ALLOW_PUBLIC_PROPERTY_FALLBACK === "true");
  if (!fallbackAllowed) return null;
  return {
    propertyId: process.env.AURORA_PUBLIC_PROPERTY_ID || "prop-seoul",
    propertySlug: "local-preview",
    organizationId: "local-preview",
    hostname,
    pathPrefix: "/hotel",
  };
}

export async function resolvePublicPropertyForRequest(
  request: Pick<Request, "headers">,
) {
  return resolvePublicPropertyForHost(trustedRequestHostname(request));
}
