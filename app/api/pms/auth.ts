/** Authentication, authorization, and migration readiness for PMS routes. */
import { authenticateSupabaseRequest } from "../../supabase-session";
import type { PmsDatabase, PmsRuntimeBindings } from "../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../db/schema-contract";
import { demoAuthenticationEnabled } from "./auth-policy";
export { demoAuthenticationEnabled } from "./auth-policy";

type D1=PmsDatabase;
export type Role="PROPERTY_ADMIN"|"NIGHT_AUDITOR"|"FRONT_DESK"|"CASHIER"|"HOUSEKEEPING"|"REVENUE_MANAGER"|"SALES_MANAGER"|"ACCOUNTANT"|"VIEWER";
export type Principal={email:string;displayName:string;role:Role;capabilities:string[];propertyId:string};
export const runtimeBindings:PmsRuntimeBindings={DATABASE_URL:process.env.DATABASE_URL};

const roleCapabilities: Record<Role, string[]> = {
  PROPERTY_ADMIN: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "AR_WRITE", "HOUSEKEEPING_WRITE", "CASHIER_WRITE", "EOD_RUN", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT", "ADMIN"],
  NIGHT_AUDITOR: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "EOD_RUN", "REPORT_EXPORT"],
  FRONT_DESK: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  CASHIER: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "REPORT_EXPORT"],
  HOUSEKEEPING: ["READ", "HOUSEKEEPING_WRITE"],
  REVENUE_MANAGER: ["READ", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "REPORT_EXPORT"],
  SALES_MANAGER: ["READ", "RESERVATION_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  ACCOUNTANT: ["READ", "FOLIO_WRITE", "AR_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT"],
  VIEWER: ["READ"],
};


let readiness: Promise<void> | null = null;

/**
 * Runtime startup is deliberately read-only. PostgreSQL schema and seed changes
 * are applied only through versioned files in supabase/migrations and seed.sql.
 */
export async function ready(db: D1) {
  if (!readiness) {
    readiness = verifyMigratedSchema(db).catch((error) => {
      readiness = null;
      throw error;
    });
  }
  await readiness;
}

async function verifyMigratedSchema(db: D1) {
  await verifyPmsSchemaContract(db);
}

function decodedDisplayName(request: Request, email: string) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded || request.headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return email;
  try { return decodeURIComponent(encoded); } catch { return email; }
}

const principalCache = new Map<string,{expires:number;role:Role;propertyId:string}>();
const principalInflight = new Map<string,Promise<{role:Role;propertyId:string}|null>>();

export async function principalFor(request: Request, db: D1): Promise<Principal | null> {
  // Authentication establishes identity; role_assignments establishes the property
  // scope. The requested property is accepted only when that same user has an active
  // assignment, preventing a client-controlled header from crossing tenant bounds.
  const identity = await authenticateSupabaseRequest(request);
  let email = identity?.email || null, displayName = identity?.displayName || "";
  if (!email && demoAuthenticationEnabled(request)) {
    email = process.env.PMS_DEMO_USER_EMAIL?.trim().toLowerCase() || null;
    displayName = email || "";
  }
  if (!email) return null;
  const requestedProperty = request.headers.get("x-aurora-property-id")?.trim() || null;
  const cacheKey = `${email}:${requestedProperty || "default"}`, cached=principalCache.get(cacheKey),now=Date.now();
  if(cached&&cached.expires>now)return {email,displayName:displayName||email,role:cached.role,capabilities:roleCapabilities[cached.role],propertyId:cached.propertyId};
  if(principalCache.size>500){for(const [key,item] of principalCache)if(item.expires<=now)principalCache.delete(key);if(principalCache.size>500)principalCache.clear();}
  let assignmentPromise=principalInflight.get(cacheKey);
  if(!assignmentPromise){
    assignmentPromise=db.prepare("SELECT property_id,role FROM role_assignments WHERE email=? AND active=1 ORDER BY created_at").bind(email).all<{property_id:string;role:Role}>().then((assignments)=>{
      const assignment=requestedProperty?assignments.results.find((item)=>item.property_id===requestedProperty):assignments.results[0];
      return assignment&&roleCapabilities[assignment.role]?{role:assignment.role,propertyId:assignment.property_id}:null;
    });
    principalInflight.set(cacheKey,assignmentPromise);
  }
  let assignment:{role:Role;propertyId:string}|null;
  try{assignment=await assignmentPromise;}finally{if(principalInflight.get(cacheKey)===assignmentPromise)principalInflight.delete(cacheKey);}
  if (!assignment) return null;
  const { role, propertyId } = assignment;
  principalCache.set(cacheKey,{expires:now+30_000,role,propertyId});
  return { email, displayName: displayName||decodedDisplayName(request, email), role, capabilities: roleCapabilities[role], propertyId };
}
