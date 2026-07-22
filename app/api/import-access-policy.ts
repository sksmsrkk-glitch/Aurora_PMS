/** One authorization contract shared by every bulk data-import entry point. */
import type { ImportKind } from "../import-csv";
import type { SupabaseIdentity } from "../supabase-session";
import { importMfaFailure, type ImportMfaFailure } from "./import-mfa-policy";

type ImportCapability = "RESERVATION_WRITE" | "USER_ADMIN";
export type ImportAccessFailure = ImportMfaFailure | {
  status: 403;
  error: string;
  code: "IMPORT_PERMISSION_REQUIRED";
};

export function requiredImportCapability(kind: ImportKind): ImportCapability {
  return kind === "RESERVATIONS" ? "RESERVATION_WRITE" : "USER_ADMIN";
}

/**
 * Reservation files follow the front-desk reservation-write boundary. Hotel
 * master files remain administrator-only. Every kind also uses the same
 * verified-identity and MFA step-up policy.
 */
export function importAccessFailure(input: {
  capabilities: readonly string[];
  identity: Pick<SupabaseIdentity, "assuranceLevel"> | null;
  kind: ImportKind;
  requireMfa?: boolean;
}): ImportAccessFailure | null {
  const required = requiredImportCapability(input.kind);
  if (!input.capabilities.includes(required)) {
    return {
      status: 403,
      error:
        required === "RESERVATION_WRITE"
          ? "예약 일괄 등록 권한이 필요합니다."
          : "호텔 마스터 데이터 이관 권한이 필요합니다.",
      code: "IMPORT_PERMISSION_REQUIRED",
    };
  }
  return importMfaFailure(input.identity, input.requireMfa);
}
