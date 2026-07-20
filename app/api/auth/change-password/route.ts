/** Authenticated first-login/self-service password replacement. */
import { getPmsDatabase, scopePmsDatabase } from "../../../../db/pms-database";
import { schemaNotReadyResponse } from "../../../../db/schema-contract";
import { consumeRateLimit, rateLimitHeaders } from "../../rate-limit";
import { invalidatePrincipalCache, principalAccessFailureResponse, principalFor, ready, runtimeBindings } from "../../pms/auth";
import { StaffAccessError, validateStaffPassword } from "../../pms/staff";
import { StaffAuthError, updateStaffAuthUser } from "../../pms/staff-auth";

export const runtime="nodejs";

export async function POST(request:Request){
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"허용되지 않은 요청 출처입니다."},{status:403});
  const rootDb=getPmsDatabase(runtimeBindings);
  try{await ready(rootDb);}catch(error){const response=schemaNotReadyResponse(error);if(response)return response;throw error;}
  const principal=await principalFor(request,rootDb);
  if(!principal)return principalAccessFailureResponse(request);
  let limit;
  try{limit=await consumeRateLimit(request,"password-change",8,15*60_000,`${principal.propertyId}:${principal.email}`,rootDb);}catch{return Response.json({error:"요청 보호 서비스를 사용할 수 없습니다."},{status:503});}
  if(!limit.allowed)return Response.json({error:"비밀번호 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."},{status:429,headers:rateLimitHeaders(limit)});
  try{
    const body=await request.json() as {password?:unknown;confirmation?:unknown};
    const password=validateStaffPassword(body.password);
    if(password!==body.confirmation)throw new StaffAccessError(400,"비밀번호 확인이 일치하지 않습니다.");
    const db=scopePmsDatabase(rootDb,principal.propertyId);
    const assignment=await db.prepare("SELECT id,auth_user_id FROM role_assignments WHERE lower(email)=lower(?) AND active AND property_id=pms_current_property_id()").bind(principal.email).first<{id:string;auth_user_id:string|null}>();
    if(!assignment?.auth_user_id)throw new StaffAccessError(409,"Auth 사용자 연결을 확인할 수 없습니다. 권한 관리자에게 문의해 주세요.");
    await updateStaffAuthUser(assignment.auth_user_id,{password});
    const now=new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE role_assignments SET must_change_password=false,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id()").bind(now,principal.email,assignment.id),
      db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'CHANGE_OWN_PASSWORD','role_assignment',?,NULL,?,?)").bind(crypto.randomUUID(),principal.email,assignment.id,{mustChangePassword:false},now),
    ]);
    invalidatePrincipalCache(principal.email);
    return Response.json({ok:true});
  }catch(error){
    if(error instanceof StaffAccessError||error instanceof StaffAuthError)return Response.json({error:error.message},{status:error.status});
    return Response.json({error:"비밀번호 변경 중 오류가 발생했습니다."},{status:500});
  }
}
