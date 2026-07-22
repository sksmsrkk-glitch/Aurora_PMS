/**
 * Shared search normalization for PMS client and server queries.
 *
 * User-entered text is NFKC-normalized so full-width characters and composed
 * Korean text compare consistently. Compact matching additionally ignores
 * punctuation and spacing, which makes digit-only phone searches reliable.
 */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("ko-KR");
}

export function normalizeSearchCompact(value: unknown): string {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function phoneDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/gu, "");
}

/** Escapes PostgreSQL LIKE metacharacters for use with `ESCAPE '\\'`. */
export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function sqlLikePattern(value: unknown): string {
  return `%${escapeSqlLike(normalizeSearchText(value))}%`;
}

export function sqlCompactPattern(value: unknown): string {
  const compact = normalizeSearchCompact(value);
  return compact ? `%${escapeSqlLike(compact)}%` : "";
}

export function sqlPhonePattern(value: unknown): string {
  return `%${escapeSqlLike(phoneDigits(value))}%`;
}

/** Includes both Western display order and natural Korean family-name order. */
export function personSearchText(
  firstName: unknown,
  lastName: unknown,
): string {
  const first = normalizeSearchText(firstName);
  const last = normalizeSearchText(lastName);
  return `${first} ${last} ${last}${first}`.trim();
}

export function matchesSearch(parts: unknown[], query: unknown): boolean {
  const keyword = normalizeSearchText(query);
  if (!keyword) return true;
  const text = normalizeSearchText(parts.join(" "));
  if (text.includes(keyword)) return true;
  const compactKeyword = normalizeSearchCompact(keyword);
  return (
    Boolean(compactKeyword) &&
    normalizeSearchCompact(text).includes(compactKeyword)
  );
}
