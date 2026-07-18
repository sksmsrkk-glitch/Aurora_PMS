/** Authentication, authorization, and migration readiness for PMS routes. */
import { authenticateSupabaseRequest } from "../../supabase-session";
import type { PmsDatabase, PmsRuntimeBindings } from "../../../db/pms-database";
import { verifyPmsSchemaContract } from "../../../db/schema-contract";
import { demoAuthenticationEnabled } from "./auth-policy";
import {
  capabilitiesForAccess,
  isRole,
  workspaceAccessFor,
  type Role,
  type WorkspaceAccess,
} from "../../access-control";
export { demoAuthenticationEnabled } from "./auth-policy";
export type { Role } from "../../access-control";

type D1=PmsDatabase;
export type Principal={
  email:string;
  displayName:string;
  role:Role;
  capabilities:string[];
  propertyId:string;
  workspaceAccess:WorkspaceAccess;
  canExport:boolean;
  mustChangePassword:boolean;
};
export const runtimeBindings:PmsRuntimeBindings={DATABASE_URL:process.env.DATABASE_URL};


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

type AssignmentPrincipal={role:Role;propertyId:string;displayName:string;workspaceAccess:WorkspaceAccess;canExport:boolean;mustChangePassword:boolean};
const principalCache = new Map<string,{expires:number;assignment:AssignmentPrincipal}>();
const principalInflight = new Map<string,Promise<AssignmentPrincipal|null>>();

/** Clears local authorization state after an assignment mutation. Short cache TTLs
 * also bound revocation propagation across independent serverless instances. */
export function invalidatePrincipalCache(email?:string) {
  if(!email){principalCache.clear();principalInflight.clear();return;}
  const prefix=`${email.trim().toLowerCase()}:`;
  for(const key of principalCache.keys())if(key.startsWith(prefix))principalCache.delete(key);
  for(const key of principalInflight.keys())if(key.startsWith(prefix))principalInflight.delete(key);
}

function buildPrincipal(email:string,identityName:string,assignment:AssignmentPrincipal):Principal{
  return {
    email,
    displayName:assignment.displayName||identityName||email,
    role:assignment.role,
    capabilities:capabilitiesForAccess(assignment.workspaceAccess,assignment.canExport),
    propertyId:assignment.propertyId,
    workspaceAccess:assignment.workspaceAccess,
    canExport:assignment.canExport,
    mustChangePassword:assignment.mustChangePassword,
  };
}

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
  const cacheKey = `${email}:${requestedProperty || "default"}:${identity?.id || "demo"}`, cached=principalCache.get(cacheKey),now=Date.now();
  if(cached&&cached.expires>now)return buildPrincipal(email,displayName,cached.assignment);
  if(principalCache.size>500){for(const [key,item] of principalCache)if(item.expires<=now)principalCache.delete(key);if(principalCache.size>500)principalCache.clear();}
  let assignmentPromise=principalInflight.get(cacheKey);
  if(!assignmentPromise){
    const lookup=identity
      ?db.findActiveRoleAssignments(identity.id,email)
      :db.findActiveDemoRoleAssignments(email);
    assignmentPromise=lookup.then((assignments)=>{
      const typedAssignments=assignments as Array<{property_id:string;role:string;display_name:string;workspace_permissions:unknown;can_export:boolean;must_change_password:boolean}>;
      const assignment=requestedProperty?typedAssignments.find((item)=>item.property_id===requestedProperty):typedAssignments[0];
      if(!assignment||!isRole(assignment.role))return null;
      return {
        role:assignment.role,
        propertyId:assignment.property_id,
        displayName:String(assignment.display_name||""),
        workspaceAccess:workspaceAccessFor(assignment.workspace_permissions,assignment.role),
        canExport:Boolean(assignment.can_export),
        mustChangePassword:Boolean(assignment.must_change_password),
      };
    });
    principalInflight.set(cacheKey,assignmentPromise);
  }
  let assignment:AssignmentPrincipal|null;
  try{assignment=await assignmentPromise;}finally{if(principalInflight.get(cacheKey)===assignmentPromise)principalInflight.delete(cacheKey);}
  if (!assignment) return null;
  principalCache.set(cacheKey,{expires:now+5_000,assignment});
  return buildPrincipal(email,displayName||decodedDisplayName(request,email),assignment);
}
