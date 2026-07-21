/** Role-aware PMS information architecture shared by the shell and tests. */

import {
  canViewWorkspace,
  type Role,
  type WorkspaceAccess,
} from "./access-control";
import type { PmsWorkspace } from "./pms-workspaces";

export type NavigationItem = {
  workspace: PmsWorkspace;
  icon: string;
  label: string;
  description: string;
};

export type NavigationGroup = {
  id: "daily" | "sales" | "finance" | "hotel";
  label: string;
  items: NavigationItem[];
};

const item = (
  workspace: PmsWorkspace,
  icon: string,
  label: string,
  description: string,
): NavigationItem => ({ workspace, icon, label, description });

/**
 * A workspace keeps its stable URL and authorization identity, while its label
 * uses the vocabulary spoken at a hotel desk. This lets us simplify navigation
 * without weakening the existing per-workspace permission matrix.
 */
const groups: Record<NavigationGroup["id"], Omit<NavigationGroup, "id">> = {
  daily: {
    label: "오늘 운영",
    items: [
      item("overview", "⌂", "오늘 업무", "도착·재실·객실 준비"),
      item("frontdesk", "⇄", "예약·체크인", "검색·배정·투숙 처리"),
      item("rooms", "▦", "객실 상태", "하우스키핑·판매 중지"),
    ],
  },
  sales: {
    label: "판매·매출",
    items: [
      item("inventory", "▤", "요금·재고", "일자별 가격·판매 한도"),
      item("channels", "⌁", "채널 관리", "OTA 계약·매핑·전송"),
      item("groups", "◎", "그룹·거래처", "블록·룸잉리스트"),
      item("revenue", "↗", "매출 분석", "채널 믹스·추세"),
    ],
  },
  finance: {
    label: "정산·회계",
    items: [
      item("finance", "₩", "폴리오·미수금", "결제·환불·AR"),
      item("accounting", "≋", "회계·손익", "분개·비용·손익"),
      item("reports", "◫", "리포트", "조회·Excel·정산"),
      item("audit", "✓", "영업일 마감", "야간 감사·검증"),
    ],
  },
  hotel: {
    label: "호텔 설정",
    items: [
      item("master", "⚙", "객실 설정", "객실 타입·호수"),
      item("website", "◇", "홈페이지", "콘텐츠·직접 예약"),
      item("users", "♙", "직원·권한", "계정·화면별 권한"),
    ],
  },
};

const defaultOrder: NavigationGroup["id"][] = [
  "daily",
  "sales",
  "finance",
  "hotel",
];

const roleOrder: Partial<Record<Role, NavigationGroup["id"][]>> = {
  FRONT_DESK: ["daily", "finance", "sales", "hotel"],
  HOUSEKEEPING: ["daily", "hotel", "sales", "finance"],
  REVENUE_MANAGER: ["sales", "daily", "finance", "hotel"],
  SALES_MANAGER: ["sales", "daily", "finance", "hotel"],
  ACCOUNTANT: ["finance", "daily", "sales", "hotel"],
  CASHIER: ["finance", "daily", "sales", "hotel"],
  NIGHT_AUDITOR: ["daily", "finance", "sales", "hotel"],
};

/** Returns only groups and pages the signed-in employee may actually open. */
export function navigationGroupsFor(
  role: Role,
  access: WorkspaceAccess,
): NavigationGroup[] {
  return (roleOrder[role] ?? defaultOrder)
    .map((id) => ({
      id,
      label: groups[id].label,
      items: groups[id].items.filter(({ workspace }) =>
        canViewWorkspace(access, workspace),
      ),
    }))
    .filter(({ items }) => items.length > 0);
}

/** A small set of role-primary pages powers the compact mobile task bar. */
export function primaryNavigationFor(
  role: Role,
  access: WorkspaceAccess,
): NavigationItem[] {
  const ordered = navigationGroupsFor(role, access).flatMap((group) => group.items);
  const preferred: Partial<Record<Role, PmsWorkspace[]>> = {
    FRONT_DESK: ["overview", "frontdesk", "rooms", "finance"],
    HOUSEKEEPING: ["overview", "rooms"],
    REVENUE_MANAGER: ["overview", "inventory", "channels", "reports"],
    SALES_MANAGER: ["overview", "groups", "frontdesk", "reports"],
    ACCOUNTANT: ["overview", "finance", "accounting", "reports"],
    CASHIER: ["overview", "finance", "reports"],
    NIGHT_AUDITOR: ["overview", "frontdesk", "finance", "audit"],
  };
  const wanted = preferred[role] ?? ["overview", "frontdesk", "inventory", "reports"];
  const primary = wanted
    .map((workspace) => ordered.find((entry) => entry.workspace === workspace))
    .filter((entry): entry is NavigationItem => Boolean(entry));
  return primary.length ? primary.slice(0, 4) : ordered.slice(0, 4);
}
