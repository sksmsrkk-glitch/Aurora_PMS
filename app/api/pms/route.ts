/** Thin Next.js PMS transport: read projection selection plus command delegation. */
import { getPmsDatabase, scopePmsDatabase } from "../../../db/pms-database";
import { ReportRequestError } from "./reporting";
import { loadAccountingCenter, loadInventoryCalendar, loadWebsiteAdmin, PmsExtendedError } from "./extended";
import { principalFor, ready, runtimeBindings } from "./auth";
import { cachedCoreSnapshotResponse, cachedReport, cachedSnapshotResponse, workspaceProjection, type WorkspaceProjection } from "./read-model";
import { handlePmsPost } from "./command-gateway";
import { schemaNotReadyResponse } from "../../../db/schema-contract";

export const dynamic="force-dynamic";
export const runtime="nodejs";

export async function GET(request: Request) {
  // All read models pass through authentication and the property-scoped adapter.
  // `view` selects a bounded projection; no branch accepts a raw table or SQL name.
  const rootDb = getPmsDatabase(runtimeBindings);
  try { await ready(rootDb); } catch (error) { const response=schemaNotReadyResponse(error); if(response)return response; throw error; }
  const principal = await principalFor(request, rootDb);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  const db = scopePmsDatabase(rootDb, principal.propertyId);
  const url=new URL(request.url);
  const view=url.searchParams.get("view");
  if(view==="core") return cachedCoreSnapshotResponse(db,principal,request);
  if(view==="groups"||view==="finance"||view==="channels") {
    return Response.json(await workspaceProjection(db,view as WorkspaceProjection),{headers:{"Cache-Control":"private, no-store"}});
  }
  if(url.searchParams.get("view")==="inventory") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
       return Response.json(await loadInventoryCalendar(db,from,to,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="accounting") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
       return Response.json(await loadAccountingCenter(db,from,to,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="website") {
    try { return Response.json(await loadWebsiteAdmin(db,principal.propertyId),{headers:{"Cache-Control":"private, no-store"}}); }
    catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="report") {
    try { return Response.json(await cachedReport(db,url.searchParams,principal),{headers:{"Cache-Control":"private, no-store"}}); }
    catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  return cachedSnapshotResponse(db,principal,request);
}


export async function POST(request:Request){
  return handlePmsPost(request);
}
