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
import { PMS_WORKSPACES, type PmsWorkspace } from "../../pms-workspaces";
import { selectedPropertyFromRequest } from "../../property-selection";
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
  organizationId:string;
  organizationName:string;
  availableProperties:Array<{id:string;name:string;code:string;slug:string;organizationId:string;organizationName:string;role:Role}>;
  principalType:"STAFF"|"SUPPORT";
  supportGrantId:string|null;
  piiMode:"MASKED"|"FULL";
  authUserId:string|null;
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

type AssignmentPrincipal={role:Role;propertyId:string;displayName:string;workspaceAccess:WorkspaceAccess;canExport:boolean;mustChangePassword:boolean;organizationId:string;organizationName:string;availableProperties:Principal["availableProperties"];principalType:"STAFF"|"SUPPORT";supportGrantId:string|null;piiMode:"MASKED"|"FULL"};
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

function buildPrincipal(email:string,identityName:string,assignment:AssignmentPrincipal,authUserId:string|null):Principal{
  return {
    email,
    displayName:assignment.displayName||identityName||email,
    role:assignment.role,
    capabilities:capabilitiesForAccess(assignment.workspaceAccess,assignment.canExport),
    propertyId:assignment.propertyId,
    workspaceAccess:assignment.workspaceAccess,
    canExport:assignment.canExport,
    mustChangePassword:assignment.mustChangePassword,
    organizationId:assignment.organizationId,
    organizationName:assignment.organizationName,
    availableProperties:assignment.availableProperties,
    principalType:assignment.principalType,
    supportGrantId:assignment.supportGrantId,
    piiMode:assignment.piiMode,
    authUserId,
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
  const requestedProperty = request.headers.get("x-aurora-property-id")?.trim() || selectedPropertyFromRequest(request);
  const cacheKey = `${email}:${requestedProperty || "default"}:${identity?.id || "demo"}:${identity?.assuranceLevel||"demo"}`, cached=principalCache.get(cacheKey),now=Date.now();
  if(cached&&cached.expires>now)return buildPrincipal(email,displayName,cached.assignment,identity?.id||null);
  if(principalCache.size>500){for(const [key,item] of principalCache)if(item.expires<=now)principalCache.delete(key);if(principalCache.size>500)principalCache.clear();}
  let assignmentPromise=principalInflight.get(cacheKey);
  if(!assignmentPromise){
    const lookup=identity
      ?db.findActiveRoleAssignments(identity.id,email)
      :db.findActiveDemoRoleAssignments(email);
    assignmentPromise=lookup.then(async(assignments)=>{
      const typedAssignments=assignments as Array<{property_id:string;property_name:string;property_code:string;property_slug:string;organization_id:string;organization_name:string;role:string;display_name:string;workspace_permissions:unknown;can_export:boolean;must_change_password:boolean;subscription_status:string;entitlements:unknown}>;
      const assignment=requestedProperty?typedAssignments.find((item)=>item.property_id===requestedProperty):typedAssignments[0];
      if(!assignment||!isRole(assignment.role)){
        // Support access is never a fallback for aal1 sessions. The database
        // grant must also be active and bound to the immutable Auth user id.
        if(!identity||identity.assuranceLevel!=="aal2")return null;
        const support=await db.findActiveSupportAssignments(identity.id,email);
        const selected=requestedProperty?support.find(item=>item.property_id===requestedProperty):support[0];
        if(!selected)return null;
        const availableProperties=support.map(item=>({id:item.property_id,name:item.property_name,code:item.property_code,slug:item.property_slug,organizationId:item.organization_id,organizationName:item.organization_name,role:"VIEWER" as Role}));
        const permissions=workspaceAccessFor(selected.workspace_permissions,"VIEWER");
        // READ grants are clamped even if a malformed stored permission object
        // contains WRITE, giving the grant's access_mode final authority.
        if(selected.access_mode==="READ")for(const workspace of Object.keys(permissions) as Array<keyof WorkspaceAccess>)if(permissions[workspace]==="WRITE")permissions[workspace]="READ";
        return {role:"VIEWER",propertyId:selected.property_id,displayName:selected.display_name,workspaceAccess:permissions,canExport:false,mustChangePassword:false,organizationId:selected.organization_id,organizationName:selected.organization_name,availableProperties,principalType:"SUPPORT",supportGrantId:selected.grant_id,piiMode:selected.pii_mode};
      }
      const availableProperties=typedAssignments.filter((item)=>isRole(item.role)).map((item)=>({
        id:item.property_id,name:item.property_name,code:item.property_code,slug:item.property_slug,
        organizationId:item.organization_id,organizationName:item.organization_name,role:item.role as Role,
      }));
      const entitled=entitledAccess(assignment.workspace_permissions,assignment.role,assignment.entitlements,assignment.subscription_status);
      return {
        role:assignment.role,
        propertyId:assignment.property_id,
        displayName:String(assignment.display_name||""),
        workspaceAccess:entitled.access,
        canExport:Boolean(assignment.can_export)&&entitled.canExport,
        mustChangePassword:Boolean(assignment.must_change_password),
        organizationId:assignment.organization_id,
        organizationName:assignment.organization_name,
        availableProperties,
        principalType:"STAFF",
        supportGrantId:null,
        piiMode:"FULL",
      };
    });
    principalInflight.set(cacheKey,assignmentPromise);
  }
  let assignment:AssignmentPrincipal|null;
  try{assignment=await assignmentPromise;}finally{if(principalInflight.get(cacheKey)===assignmentPromise)principalInflight.delete(cacheKey);}
  if (!assignment) return null;
  principalCache.set(cacheKey,{expires:now+5_000,assignment});
  return buildPrincipal(email,displayName||decodedDisplayName(request,email),assignment,identity?.id||null);
}

/** Distinguishes an expired/missing Auth session from a valid identity whose
 * hotel was suspended, closed, or unassigned. Clients must redirect only the
 * former to /login; the latter is a stable authorization error, not a login
 * challenge. */
export async function principalAccessFailureResponse(request: Request) {
  const identity = await authenticateSupabaseRequest(request);
  if (identity)
    return Response.json(
      {
        error:
          "현재 접근 가능한 호텔이 없습니다. 호텔 상태와 구독 또는 계정 배정을 확인해 주세요.",
        code: "TENANT_ACCESS_INACTIVE",
      },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  return Response.json(
    { error: "로그인이 필요합니다.", code: "AUTH_REQUIRED" },
    { status: 401, headers: { "Cache-Control": "private, no-store" } },
  );
}

/** Subscription state and feature flags are authoritative server-side gates.
 * Hiding a navigation item alone would still leave the command API callable. */
function entitledAccess(value:unknown,role:Role,rawEntitlements:unknown,subscriptionStatus:string){
  const access=workspaceAccessFor(value,role);
  let parsed=rawEntitlements;
  if(typeof parsed==="string")try{parsed=JSON.parse(parsed);}catch{parsed={};}
  const features=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  if(["SUSPENDED","CANCELLED"].includes(subscriptionStatus)||features.CORE_PMS===false){
    for(const workspace of PMS_WORKSPACES)access[workspace]="NONE";
    return {access,canExport:false};
  }
  const gates:Partial<Record<PmsWorkspace,string>>={
    website:"WEBSITE_CMS",groups:"GROUP_SALES",finance:"ACCOUNTING",
    accounting:"ACCOUNTING",channels:"CHANNEL_HUB",revenue:"ACCOUNTING",users:"STAFF_ACCESS",
  };
  for(const [workspace,feature] of Object.entries(gates) as Array<[PmsWorkspace,string]>)if(features[feature]===false)access[workspace]="NONE";
  return {access,canExport:features.REPORT_EXPORT!==false};
}
