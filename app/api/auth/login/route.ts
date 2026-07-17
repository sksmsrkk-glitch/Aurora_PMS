/** Same-origin login endpoint that issues hardened Supabase session cookies. */
import { signInWithPassword } from "../../../supabase-session";

export const runtime = "nodejs";

const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request) {
  return (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
}

export async function POST(request: Request) {
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"허용되지 않은 요청 출처입니다."},{status:403});
  const key=clientKey(request),now=Date.now(),prior=attempts.get(key);
  if(prior&&prior.resetAt>now&&prior.count>=8)return Response.json({error:"로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."},{status:429,headers:{"Retry-After":String(Math.ceil((prior.resetAt-now)/1000))}});
  if(!prior||prior.resetAt<=now)attempts.set(key,{count:1,resetAt:now+60_000});else attempts.set(key,{...prior,count:prior.count+1});
  let body: { email?: string; password?: string };
  try { body = await request.json() as { email?: string; password?: string }; }
  catch { return Response.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 }); }
  const identity = await signInWithPassword(body.email || "", body.password || "");
  if (!identity) return Response.json({ error: "이메일 또는 비밀번호를 확인해 주세요." }, { status: 401 });
  attempts.delete(key);
  return Response.json({ user: identity }, { headers: { "Cache-Control": "no-store" } });
}
