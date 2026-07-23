/** Opaque, query-bound keyset cursors for stable mixed-domain PMS search. */
import { createHash } from "node:crypto";

export const SEARCH_CURSOR_KINDS = [
  "reservations",
  "rooms",
  "finance",
] as const;
export type SearchCursorKind = (typeof SEARCH_CURSOR_KINDS)[number];

export type SearchCursor = {
  v: 1;
  kind: SearchCursorKind;
  anchor: string;
  rank: number;
  sortAt: string;
  id: string;
  queryFingerprint: string;
};

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const FINGERPRINT = /^[a-f0-9]{24}$/u;

export function searchQueryFingerprint(normalizedQuery: string) {
  // The browser-visible cursor never contains a customer name, phone number,
  // email, confirmation number, or recoverable copy of the query.
  return createHash("sha256")
    .update(normalizedQuery, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function encodeSearchCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSearchCursor(
  encoded: string,
  expectedKind: SearchCursorKind,
  expectedQueryFingerprint: string,
): SearchCursor | null {
  if (!encoded || encoded.length > 640 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SearchCursor>;
    if (
      parsed.v !== 1 ||
      parsed.kind !== expectedKind ||
      parsed.queryFingerprint !== expectedQueryFingerprint ||
      !FINGERPRINT.test(parsed.queryFingerprint) ||
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
