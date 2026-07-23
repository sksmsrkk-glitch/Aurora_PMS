/** Signed, tenant/query-bound keyset cursors for stable mixed-domain PMS search. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SEARCH_CURSOR_KINDS = [
  "reservations",
  "rooms",
  "finance",
] as const;
export type SearchCursorKind = (typeof SEARCH_CURSOR_KINDS)[number];

export type SearchCursor = {
  v: 2;
  kind: SearchCursorKind;
  anchor: string;
  rank: number;
  sortAt: string;
  id: string;
  queryFingerprint: string;
  propertyFingerprint: string;
};

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const FINGERPRINT = /^[a-f0-9]{24}$/u;

function fingerprint(value: string) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function searchQueryFingerprint(normalizedQuery: string) {
  // The browser-visible cursor never contains a customer name, phone number,
  // email, confirmation number, or recoverable copy of the query.
  return fingerprint(normalizedQuery);
}

export function searchPropertyFingerprint(propertyId: string) {
  return fingerprint(`property:${propertyId}`);
}

function signingSecret() {
  const secret = (
    process.env.SEARCH_CURSOR_SECRET ||
    process.env.AUTH_SECRET ||
    ""
  ).trim();
  if (secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SEARCH_CURSOR_SECRET or AUTH_SECRET must contain at least 32 characters",
    );
  }
  // Local/unit execution receives a deterministic non-production key. CI and
  // production always provide AUTH_SECRET, and production fails closed above.
  return "talos-local-only-search-cursor-secret-2026";
}

function signature(payload: string) {
  return createHmac("sha256", signingSecret())
    .update(payload, "utf8")
    .digest("base64url");
}

export function encodeSearchCursor(cursor: SearchCursor) {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signature(payload)}`;
}

export function decodeSearchCursor(
  encoded: string,
  expectedKind: SearchCursorKind,
  expectedQueryFingerprint: string,
  expectedPropertyFingerprint: string,
): SearchCursor | null {
  if (
    !encoded ||
    encoded.length > 800 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(encoded)
  )
    return null;
  try {
    const [payload, suppliedSignature] = encoded.split(".");
    const expectedSignature = signature(payload);
    const suppliedBuffer = Buffer.from(suppliedSignature, "base64url");
    const expectedBuffer = Buffer.from(expectedSignature, "base64url");
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    )
      return null;
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SearchCursor>;
    if (
      parsed.v !== 2 ||
      parsed.kind !== expectedKind ||
      parsed.queryFingerprint !== expectedQueryFingerprint ||
      parsed.propertyFingerprint !== expectedPropertyFingerprint ||
      !FINGERPRINT.test(parsed.queryFingerprint) ||
      !FINGERPRINT.test(parsed.propertyFingerprint) ||
      typeof parsed.anchor !== "string" ||
      !ISO_TIMESTAMP.test(parsed.anchor) ||
      !Number.isFinite(Date.parse(parsed.anchor)) ||
      typeof parsed.sortAt !== "string" ||
      !ISO_TIMESTAMP.test(parsed.sortAt) ||
      !Number.isFinite(Date.parse(parsed.sortAt)) ||
      typeof parsed.rank !== "number" ||
      !Number.isFinite(parsed.rank) ||
      parsed.rank < 0 ||
      parsed.rank > 2000 ||
      typeof parsed.id !== "string" ||
      parsed.id.length < 1 ||
      parsed.id.length > 160
    )
      return null;
    return parsed as SearchCursor;
  } catch {
    return null;
  }
}
