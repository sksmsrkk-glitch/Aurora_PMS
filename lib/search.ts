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

const KOREAN_INITIALS = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
] as const;

/**
 * Builds the Korean initial-consonant representation used by quick searches.
 * Non-Hangul characters are preserved so mixed queries such as `DLX ㄷㄹㅅ`
 * continue to work without maintaining a second search implementation.
 */
export function koreanInitialSearchText(value: unknown): string {
  return Array.from(normalizeSearchText(value), (character) => {
    const code = character.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return character;
    return KOREAN_INITIALS[Math.floor((code - 0xac00) / 588)] ?? character;
  }).join("");
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

/**
 * Adds compact forward and reverse token aliases for a stored display name.
 * This covers PMS records that expose only `민지 김` while hotel staff search
 * with the natural Korean order `김민지` (and vice versa).
 */
export function personDisplaySearchText(value: unknown): string {
  const normalized = normalizeSearchText(value);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < 2) return normalized;
  return `${normalized} ${tokens.join("")} ${[...tokens].reverse().join("")}`;
}

export function matchesSearch(parts: unknown[], query: unknown): boolean {
  const keyword = normalizeSearchText(query);
  if (!keyword) return true;
  const text = normalizeSearchText(parts.join(" "));
  if (text.includes(keyword)) return true;
  const compactKeyword = normalizeSearchCompact(keyword);
  if (!compactKeyword) return true;
  const compactText = normalizeSearchCompact(text);
  if (compactText.includes(compactKeyword)) return true;

  const compactInitials = normalizeSearchCompact(koreanInitialSearchText(text));
  if (compactInitials.includes(compactKeyword)) return true;

  // Multi-token input is intentionally order-independent. Hotel staff often
  // paste `객실번호 고객명` or enter a Korean name with optional whitespace.
  const tokens = keyword.split(" ").map(normalizeSearchCompact).filter(Boolean);
  return (
    tokens.length > 1 &&
    tokens.every(
      (token) =>
        compactText.includes(token) || compactInitials.includes(token),
    )
  );
}
