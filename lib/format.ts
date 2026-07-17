/** Locale-safe formatting and calendar helpers shared by PMS and public pages. */

export function formatMoney(value: unknown, currency = "KRW") {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

export function formatNumber(value: unknown) {
  return new Intl.NumberFormat("ko-KR").format(Number(value) || 0);
}

/** Adds whole calendar days to a timezone-free ISO hotel business date. */
export function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Returns a Seoul calendar date without depending on the server timezone. */
export function seoulDateAfter(days: number, now = Date.now()) {
  const date = new Date(now + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** Normalizes PostgreSQL JSONB arrays and legacy serialized JSON arrays. */
export function safeStringArray(value: unknown, maximum = 100) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, maximum);
  } catch {
    return [];
  }
}
