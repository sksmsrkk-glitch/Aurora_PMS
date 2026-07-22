/** Front-desk reservation CSV import: dry-run, atomic commit, rollback, and history. */
import { z } from "zod";
import { getPmsDatabase, scopePmsDatabase } from "../../../../db/pms-database";
import { schemaNotReadyResponse } from "../../../../db/schema-contract";
import { consumeRateLimit, rateLimitHeaders } from "../../rate-limit";
import { commit, dryRun, rollback } from "../../platform/imports/route";
import { principalAccessFailureResponse, principalFor, ready, runtimeBindings } from "../auth";
import { authenticateSupabaseRequest } from "../../../supabase-session";
import { importAccessFailure } from "../../import-access-policy";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const requestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("dry_run"),sourceName:z.string().trim().min(1).max(180),csv:z.string().min(1).max(2_000_000)}),
  z.object({action:z.literal("commit"),jobId:z.string().min(3).max(200)}),
  z.object({action:z.literal("rollback"),jobId:z.string().min(3).max(200)}),
]);
const response=(body:unknown,status=200,headers:HeadersInit={})=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store",...headers}});

async function context(request:Request,requireStepUp=false){
  const root=getPmsDatabase(runtimeBindings);try{await ready(root);}catch(error){const rejected=schemaNotReadyResponse(error);if(rejected)return {rejected};throw error;}
  const principal=await principalFor(request,root);if(!principal)return {rejected:await principalAccessFailureResponse(request)};
  const failure=importAccessFailure({capabilities:principal.capabilities,identity:requireStepUp?await authenticateSupabaseRequest(request):{assuranceLevel:"aal2"},kind:"RESERVATIONS"});
  if(failure){const {status,...body}=failure;return {rejected:response(body,status)};}
  const db=scopePmsDatabase(root,principal.propertyId),entitlement=await db.prepare("SELECT enabled FROM property_entitlements WHERE property_id=pms_current_property_id() AND feature_key='DATA_IMPORT'").first<{enabled:boolean}>();
  if(!entitlement?.enabled)return {rejected:response({error:"이 호텔 플랜에는 데이터 가져오기 기능이 활성화되지 않았습니다."},403)};
  return {root,db,principal};
}

export async function GET(request:Request){
  const resolved=await context(request,true);if("rejected" in resolved)return resolved.rejected;
  const jobs=await resolved.db.prepare("SELECT id,mode,status,source_name,row_count,valid_count,error_count,summary,created_at,created_by,committed_at,rolled_back_at FROM data_import_jobs WHERE property_id=pms_current_property_id() AND kind='RESERVATIONS' ORDER BY created_at DESC LIMIT 30").all();
  return response({jobs:jobs.results});
}

export async function POST(request:Request){
  if(Number(request.headers.get("content-length")||0)>2_100_000)return response({error:"업로드 파일이 허용 크기를 초과했습니다."},413);
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return response({error:"허용되지 않은 요청 출처입니다."},403);
  const resolved=await context(request,true);if("rejected" in resolved)return resolved.rejected;
  let limit;try{limit=await consumeRateLimit(request,"reservation-import",20,60_000,`${resolved.principal.propertyId}:${resolved.principal.email}`,resolved.root);}catch{return response({error:"요청 보호 서비스를 사용할 수 없습니다."},503,{"Retry-After":"30"});}
  if(!limit.allowed)return response({error:"가져오기 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."},429,rateLimitHeaders(limit));
  const parsed=requestSchema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return response({error:"가져오기 요청 형식을 확인해 주세요.",details:parsed.error.issues.map(issue=>issue.message).join(", ")},400);
  try{
    if(parsed.data.action==="dry_run")return dryRun(resolved.db,resolved.principal.email,"RESERVATIONS",parsed.data.sourceName,parsed.data.csv);
    if(parsed.data.action==="commit")return commit(resolved.db,resolved.principal.email,parsed.data.jobId,"RESERVATIONS");
    return rollback(resolved.db,resolved.principal.email,parsed.data.jobId,"RESERVATIONS");
  }catch(error){const message=error instanceof Error?error.message:"예약 가져오기를 완료하지 못했습니다.";return response({error:message},/duplicate|unique|changed|VALIDATED/iu.test(message)?409:400);}
}
