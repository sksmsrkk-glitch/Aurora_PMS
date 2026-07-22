/** Shared step-up authentication policy for every CSV data-import boundary. */
import type { SupabaseIdentity } from "../supabase-session";

export type ImportMfaFailure={status:401|403;error:string;code:"AUTH_REQUIRED"|"MFA_REQUIRED"};

/**
 * Import endpoints handle bulk operational and personal data, so they require an
 * authenticated Supabase identity and, by default, an aal2 session. The explicit
 * environment opt-out exists for controlled installations but production should
 * leave step-up authentication enabled.
 */
export function importMfaFailure(
  identity:Pick<SupabaseIdentity,"assuranceLevel">|null,
  requireMfa=process.env.PMS_REQUIRE_PLATFORM_MFA!=="false",
):ImportMfaFailure|null{
  if(!identity)return {status:401,error:"로그인이 필요합니다.",code:"AUTH_REQUIRED"};
  if(requireMfa&&identity.assuranceLevel!=="aal2")
    return {status:403,error:"데이터 이관에는 MFA 추가 인증이 필요합니다.",code:"MFA_REQUIRED"};
  return null;
}
