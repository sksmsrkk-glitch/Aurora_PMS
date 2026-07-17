/** Shared, side-effect-free contract for the visual website editor and public renderer. */
export const WEBSITE_SECTION_IDS = ["stay", "experience", "location"] as const;

export type WebsiteSectionId = (typeof WEBSITE_SECTION_IDS)[number];
export type WebsiteHeroLayout = "LEFT" | "CENTER" | "SPLIT";
export type WebsiteNavigationItem = {
  id: WebsiteSectionId;
  label: string;
  enabled: boolean;
};

export const DEFAULT_WEBSITE_NAVIGATION: WebsiteNavigationItem[] = [
  { id: "stay", label: "STAY", enabled: true },
  { id: "experience", label: "EXPERIENCE", enabled: true },
  { id: "location", label: "LOCATION", enabled: true },
];

const sectionIdSet = new Set<string>(WEBSITE_SECTION_IDS);

/**
 * Accepts PostgreSQL jsonb, a JSON string, or an unknown legacy value and always
 * returns every supported section exactly once. Invalid entries fall back to the
 * canonical labels, preventing arbitrary links or duplicate DOM anchors.
 */
export function normalizeWebsiteNavigation(value: unknown): WebsiteNavigationItem[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  const source = Array.isArray(parsed) ? parsed : [];
  const found = new Map<WebsiteSectionId, WebsiteNavigationItem>();
  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const id = String(row.id || "") as WebsiteSectionId;
    if (!sectionIdSet.has(id) || found.has(id)) continue;
    const fallback = DEFAULT_WEBSITE_NAVIGATION.find((item) => item.id === id)!;
    const label = typeof row.label === "string" ? row.label.trim().slice(0, 24) : "";
    found.set(id, { id, label: label || fallback.label, enabled: row.enabled !== false });
  }
  for (const fallback of DEFAULT_WEBSITE_NAVIGATION) {
    if (!found.has(fallback.id)) found.set(fallback.id, { ...fallback });
  }
  return [...found.values()];
}

/** Strict publishing validation used at the server command boundary. */
export function validateWebsiteNavigation(value: unknown): WebsiteNavigationItem[] {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new Error("메뉴 설정 형식을 확인하세요."); }
  if (!Array.isArray(parsed) || parsed.length !== WEBSITE_SECTION_IDS.length) throw new Error("홈페이지 메뉴는 3개 섹션을 모두 포함해야 합니다.");
  const normalized = normalizeWebsiteNavigation(parsed);
  const inputIds = parsed.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).id || "") : "");
  if (new Set(inputIds).size !== WEBSITE_SECTION_IDS.length || inputIds.some((id) => !sectionIdSet.has(id))) throw new Error("메뉴 섹션은 중복 없이 객실·경험·위치만 사용할 수 있습니다.");
  if (!normalized.some((item) => item.enabled)) throw new Error("메뉴와 본문 섹션을 하나 이상 노출하세요.");
  if (parsed.some((item) => typeof (item as Record<string, unknown>)?.label !== "string" || !(item as Record<string, unknown>).label?.toString().trim() || (item as Record<string, unknown>).label!.toString().trim().length > 24)) throw new Error("메뉴명은 1~24자로 입력하세요.");
  return normalized;
}

export function normalizeHeroLayout(value: unknown): WebsiteHeroLayout {
  return value === "CENTER" || value === "SPLIT" ? value : "LEFT";
}

export function normalizeAccentColor(value: unknown) {
  const color = String(value || "").trim();
  return /^#[0-9A-Fa-f]{6}$/u.test(color) ? color.toUpperCase() : "#2764E7";
}

export function normalizeHeroCtaHref(value: unknown) {
  const href = String(value || "");
  return href === "/hotel/book" || WEBSITE_SECTION_IDS.some((id) => href === `#${id}`) ? href : "#stay";
}

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
