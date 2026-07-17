/** Secret-free readiness and database latency probe. */
import { getPmsDatabase, type PmsRuntimeBindings } from "../../../db/pms-database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bindings:PmsRuntimeBindings={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_SECRET_KEY:process.env.SUPABASE_SECRET_KEY,DATABASE_URL:process.env.DATABASE_URL};

export async function GET() {
  const started=Date.now();
  try {
    const database=getPmsDatabase(bindings),result=await database.prepare("SELECT COUNT(*) count FROM properties").first<{count:number}>();
    if(!result||Number(result.count)<1)throw new Error("property catalog unavailable");
    return Response.json({status:"ok",service:"aurora-pms",database:"ready",latencyMs:Date.now()-started,timestamp:new Date().toISOString()},{headers:{"Cache-Control":"no-store"}});
  } catch {
    return Response.json({status:"degraded",service:"aurora-pms",database:"unavailable",timestamp:new Date().toISOString()},{status:503,headers:{"Cache-Control":"no-store","Retry-After":"30"}});
  }
}
