/** Privacy-bounded, browser-session history for entities opened from PMS search. */

export type SearchHistoryTarget = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  meta: string;
  path: string;
};

export type SearchHistoryEntry = SearchHistoryTarget & {
  selectionCount: number;
  lastSelectedAt: number;
};

export const SEARCH_HISTORY_LIMIT = 8;
export const SEARCH_HISTORY_TTL_MS = 4 * 60 * 60 * 1000;
export const SEARCH_HISTORY_STORAGE_PREFIX = "talos:pms-search-history:";

function isBoundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isSafeTarget(value: unknown): value is SearchHistoryTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<SearchHistoryTarget>;
  return (
    isBoundedString(target.id, 160) &&
    isBoundedString(target.kind, 32) &&
    isBoundedString(target.title, 240) &&
    isBoundedString(target.subtitle, 320) &&
    typeof target.meta === "string" &&
    target.meta.length <= 320 &&
    isBoundedString(target.path, 800) &&
    target.path!.startsWith("/") &&
    !target.path!.startsWith("//")
  );
}

function compareHistory(left: SearchHistoryEntry, right: SearchHistoryEntry) {
  // Frequency is the primary autocomplete signal; recency deterministically
  // resolves ties so a newly selected entity is never buried.
  return (
    right.selectionCount - left.selectionCount ||
    right.lastSelectedAt - left.lastSelectedAt ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

/** Add a selected entity without retaining the raw query that found it. */
export function updateSearchHistory(
  current: SearchHistoryEntry[],
  target: SearchHistoryTarget,
  now = Date.now(),
) {
  if (!isSafeTarget(target) || !Number.isFinite(now)) return current;
  const previous = current.find(
    (entry) => entry.kind === target.kind && entry.id === target.id,
  );
  const next: SearchHistoryEntry = {
    ...target,
    selectionCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      (previous?.selectionCount ?? 0) + 1,
    ),
    lastSelectedAt: now,
  };
  return [
    next,
    ...current.filter(
      (entry) => entry.kind !== target.kind || entry.id !== target.id,
    ),
  ]
    .filter((entry) => now - entry.lastSelectedAt <= SEARCH_HISTORY_TTL_MS)
    .sort(compareHistory)
    .slice(0, SEARCH_HISTORY_LIMIT);
}

/** Reject malformed, stale, oversized, or cross-origin paths before rendering. */
export function parseSearchHistory(serialized: string | null, now = Date.now()) {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed) || parsed.length > SEARCH_HISTORY_LIMIT)
      return [];
    return parsed
      .filter((entry): entry is SearchHistoryEntry => {
        if (!isSafeTarget(entry)) return false;
        const candidate = entry as Partial<SearchHistoryEntry>;
        return (
          Number.isSafeInteger(candidate.selectionCount) &&
          candidate.selectionCount! > 0 &&
          Number.isFinite(candidate.lastSelectedAt) &&
          candidate.lastSelectedAt! <= now &&
          now - candidate.lastSelectedAt! <= SEARCH_HISTORY_TTL_MS
        );
      })
      .sort(compareHistory)
      .slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}
