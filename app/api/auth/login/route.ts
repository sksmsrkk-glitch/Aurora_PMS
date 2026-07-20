/** Same-origin login endpoint that issues hardened Supabase session cookies. */
import { getPmsDatabase } from "../../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../../db/schema-contract";
import { signInWithPassword, signOut } from "../../../supabase-session";
import { hasUsableTenantAccess } from "../../../tenant-access";
import { consumeRateLimit, rateLimitHeaders } from "../../rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"허용되지 않은 요청 출처입니다."},{status:403});
  let rateLimit;
  try { rateLimit=await consumeRateLimit(request,"auth-login",8,60_000); }
  catch { return Response.json({error:"로그인 보호 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요."},{status:503,headers:{"Retry-After":"30"}}); }
  if(!rateLimit.allowed)return Response.json({error:"로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."},{status:429,headers:rateLimitHeaders(rateLimit)});
  let body: { email?: string; password?: string };
  try { body = await request.json() as { email?: string; password?: string }; }
  catch { return Response.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 }); }
  const identity = await signInWithPassword(body.email || "", body.password || "");
  if (!identity) return Response.json({ error: "이메일 또는 비밀번호를 확인해 주세요." }, { status: 401 });
  try {
    const database = getPmsDatabase({ DATABASE_URL: process.env.DATABASE_URL });
    await verifyPmsSchemaContract(database);
    const assignments = await database.findActiveRoleAssignments(
      identity.id,
      identity.email,
    );
    const hasUsableProperty = hasUsableTenantAccess(assignments);
    const support =
      !hasUsableProperty && identity.assuranceLevel === "aal2"
        ? await database.findActiveSupportAssignments(identity.id, identity.email)
        : [];
    if (!hasUsableTenantAccess(assignments, support.length)) {
      // Authentication and hotel authorization are separate. Clearing the new
      // session here prevents a valid Supabase identity with no active tenant
      // from bouncing forever between the login screen and the PMS shell.
      await signOut();
      return Response.json(
        {
          error:
            "현재 접근 가능한 호텔이 없습니다. 호텔 상태와 구독 또는 계정 배정을 확인해 주세요.",
          code: "TENANT_ACCESS_INACTIVE",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    await signOut();
    return Response.json(
      {
        error: "호텔 접근 권한을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        code: "ACCESS_CHECK_UNAVAILABLE",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "30" },
      },
    );
  }
  return Response.json({ user: identity }, { headers: { "Cache-Control": "no-store" } });
}
