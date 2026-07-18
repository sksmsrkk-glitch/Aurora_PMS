/** Shared, serializable staff access model used by the API and PMS client. */
import { PMS_WORKSPACES, type PmsWorkspace } from "./pms-workspaces";

export const PMS_ROLES = [
  "PROPERTY_ADMIN", "NIGHT_AUDITOR", "FRONT_DESK", "CASHIER",
  "HOUSEKEEPING", "REVENUE_MANAGER", "SALES_MANAGER", "ACCOUNTANT", "VIEWER",
] as const;

export type Role = (typeof PMS_ROLES)[number];
export type AccessMode = "NONE" | "READ" | "WRITE";
export type WorkspaceAccess = Record<PmsWorkspace, AccessMode>;

export const WORKSPACE_LABELS: Record<PmsWorkspace, string> = {
  overview: "오늘의 오퍼레이션", frontdesk: "프런트 데스크", inventory: "재고 & 요금",
  website: "호텔 홈페이지", groups: "그룹 & 세일즈", finance: "폴리오 & 매출채권",
  accounting: "회계 & 손익", channels: "채널 허브", rooms: "룸 & 하우스키핑",
  reports: "통합 리포트", master: "객실 마스터", revenue: "매출 & 인사이트",
  users: "직원 & 권한", audit: "야간 감사",
};

export const ROLE_LABELS: Record<Role, string> = {
  PROPERTY_ADMIN: "프로퍼티 관리자", NIGHT_AUDITOR: "야간 감사", FRONT_DESK: "프런트 데스크",
  CASHIER: "캐셔", HOUSEKEEPING: "하우스키핑", REVENUE_MANAGER: "레비뉴 매니저",
  SALES_MANAGER: "세일즈 매니저", ACCOUNTANT: "호텔 회계", VIEWER: "조회 전용",
};

function matrix(overrides: Partial<WorkspaceAccess>): WorkspaceAccess {
  return Object.fromEntries(PMS_WORKSPACES.map((workspace) => [workspace, overrides[workspace] ?? "NONE"])) as WorkspaceAccess;
}

const all = (mode: AccessMode) => matrix(Object.fromEntries(PMS_WORKSPACES.map((workspace) => [workspace, mode])) as Partial<WorkspaceAccess>);

/** Roles remain convenient templates; the saved per-workspace matrix is authoritative. */
export const ROLE_ACCESS_TEMPLATES: Record<Role, { permissions: WorkspaceAccess; canExport: boolean }> = {
  PROPERTY_ADMIN: { permissions: all("WRITE"), canExport: true },
  NIGHT_AUDITOR: { permissions: matrix({ overview:"READ", frontdesk:"READ", rooms:"READ", finance:"WRITE", accounting:"READ", reports:"READ", audit:"WRITE" }), canExport: true },
  FRONT_DESK: { permissions: matrix({ overview:"READ", frontdesk:"WRITE", rooms:"READ", finance:"WRITE", groups:"READ", reports:"READ" }), canExport: true },
  CASHIER: { permissions: matrix({ overview:"READ", finance:"WRITE", accounting:"READ", reports:"READ" }), canExport: true },
  HOUSEKEEPING: { permissions: matrix({ overview:"READ", rooms:"WRITE" }), canExport: false },
  REVENUE_MANAGER: { permissions: matrix({ overview:"READ", inventory:"WRITE", groups:"WRITE", channels:"WRITE", reports:"READ", master:"READ", revenue:"READ" }), canExport: true },
  SALES_MANAGER: { permissions: matrix({ overview:"READ", frontdesk:"WRITE", groups:"WRITE", reports:"READ", revenue:"READ" }), canExport: true },
  ACCOUNTANT: { permissions: matrix({ overview:"READ", finance:"WRITE", accounting:"WRITE", reports:"READ", revenue:"READ" }), canExport: true },
  VIEWER: { permissions: matrix(Object.fromEntries(PMS_WORKSPACES.filter((workspace) => workspace !== "users").map((workspace) => [workspace, "READ"])) as Partial<WorkspaceAccess>), canExport: false },
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (PMS_ROLES as readonly string[]).includes(value);
}

/** Strict parsing prevents a malformed JSON permission map from silently granting access. */
export function parseWorkspaceAccess(value: unknown): WorkspaceAccess | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const source = candidate as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some((key) => !(PMS_WORKSPACES as readonly string[]).includes(key))) return null;
  const output = {} as WorkspaceAccess;
  for (const workspace of PMS_WORKSPACES) {
    const mode = source[workspace];
    if (mode !== "NONE" && mode !== "READ" && mode !== "WRITE") return null;
    output[workspace] = mode;
  }
  return output;
}

/** Backward-compatible fallback is used only while migrating an older assignment row. */
export function workspaceAccessFor(value: unknown, role: Role): WorkspaceAccess {
  return parseWorkspaceAccess(value) ?? structuredClone(ROLE_ACCESS_TEMPLATES[role].permissions);
}

export function canViewWorkspace(access: WorkspaceAccess, workspace: PmsWorkspace) {
  return access[workspace] !== "NONE";
}

const writeCapabilities: Partial<Record<PmsWorkspace, readonly string[]>> = {
  frontdesk: ["RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE"],
  inventory: ["INVENTORY_WRITE"], website: ["WEBSITE_WRITE"],
  groups: ["GROUP_WRITE", "GROUP_PICKUP"], finance: ["FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE"],
  accounting: ["ACCOUNTING_WRITE"], channels: ["INTEGRATION_WRITE"],
  rooms: ["HOUSEKEEPING_WRITE"], master: ["MASTER_WRITE"], users: ["USER_ADMIN"], audit: ["EOD_RUN"],
};

export function capabilitiesForAccess(access: WorkspaceAccess, canExport: boolean) {
  const capabilities = new Set<string>();
  if (PMS_WORKSPACES.some((workspace) => access[workspace] !== "NONE")) capabilities.add("READ");
  for (const workspace of PMS_WORKSPACES) {
    if (access[workspace] === "WRITE") for (const capability of writeCapabilities[workspace] ?? []) capabilities.add(capability);
  }
  if (canExport && access.reports !== "NONE") capabilities.add("REPORT_EXPORT");
  return [...capabilities];
}

export function firstAccessibleWorkspace(access: WorkspaceAccess): PmsWorkspace | null {
  return PMS_WORKSPACES.find((workspace) => canViewWorkspace(access, workspace)) ?? null;
}
