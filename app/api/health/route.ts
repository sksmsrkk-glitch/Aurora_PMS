/** Secret-free readiness and database latency probe. */
import { getPmsDatabase, scopePmsDatabase, type PmsRuntimeBindings } from "../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../db/schema-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bindings:PmsRuntimeBindings={DATABASE_URL:process.env.DATABASE_URL};

function deploymentEnvironment() {
  return process.env.PMS_ENVIRONMENT || (process.env.VERCEL_ENV === "production" ? "production" : "development");
}

function databaseProjectRef() {
  try {
    const url=new URL(process.env.DATABASE_URL || "");
    if(url.username.includes("."))return url.username.split(".").at(-1) || "unknown";
    const direct=url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/u);
    return direct?.[1] || "non-supabase";
  } catch { return "unconfigured"; }
}

export async function GET() {
  const started=Date.now();
  try {
    const rootDatabase=getPmsDatabase(bindings),contract=await verifyPmsSchemaContract(rootDatabase),database=scopePmsDatabase(rootDatabase,process.env.AURORA_PUBLIC_PROPERTY_ID||"prop-seoul"),result=await database.prepare("SELECT COUNT(*) count FROM properties WHERE id=pms_current_property_id()").first<{count:number}>();
    if(!result||Number(result.count)<1)throw new Error("property catalog unavailable");
    const environment=deploymentEnvironment();
    return Response.json({status:"ok",service:"aurora-pms",database:"ready",schemaVersion:contract.version,environment,qaAllowed:environment==="staging"&&process.env.PMS_ALLOW_DESTRUCTIVE_QA==="true",databaseProjectRef:databaseProjectRef(),latencyMs:Date.now()-started,timestamp:new Date().toISOString()},{headers:{"Cache-Control":"no-store"}});
  } catch {
    return Response.json({status:"degraded",service:"aurora-pms",database:"unavailable",timestamp:new Date().toISOString()},{status:503,headers:{"Cache-Control":"no-store","Retry-After":"30"}});
  }
}
