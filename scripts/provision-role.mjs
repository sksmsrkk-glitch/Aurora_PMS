/** Explicit operator-only PMS role provisioning; runtime and seed paths never grant roles. */
import postgres from "postgres";
import { PMS_ROLES, ROLE_ACCESS_TEMPLATES } from "../app/access-control.ts";

const allowedRoles=new Set(PMS_ROLES);
const directUrl=process.env.DIRECT_URL||"";
const propertyId=process.env.PMS_PROVISION_PROPERTY_ID||"prop-seoul";
const email=(process.env.PMS_PROVISION_EMAIL||"").trim().toLowerCase();
const role=process.env.PMS_PROVISION_ROLE||"";
const displayName=(process.env.PMS_PROVISION_DISPLAY_NAME||email.split("@")[0]||"").trim();
if(process.env.PMS_PROVISION_ROLE_CONFIRM!=="AURORA_PROVISION_ROLE")throw new Error("PMS_PROVISION_ROLE_CONFIRM=AURORA_PROVISION_ROLE is required");
if(!/^postgres(?:ql)?:\/\//u.test(directUrl))throw new Error("DIRECT_URL is required");
if(!/^\S+@\S+\.\S+$/u.test(email)||!allowedRoles.has(role)||displayName.length<2||displayName.length>80||!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId))throw new Error("Invalid role provisioning input");

const sql=postgres(directUrl,{max:1,prepare:false,ssl:"require",connect_timeout:15,idle_timeout:5});
try {
  const template=ROLE_ACCESS_TEMPLATES[role];
  const authUsers=await sql.unsafe("SELECT id FROM auth.users WHERE lower(email)=lower($1) LIMIT 1",[email]);
  const authUserId=authUsers[0]?.id||null;
  await sql`
    INSERT INTO role_assignments(id,property_id,email,role,active,created_at,auth_user_id,display_name,workspace_permissions,can_export,updated_at,updated_by)
    VALUES (${crypto.randomUUID()},${propertyId},${email},${role},true,${new Date().toISOString()},${authUserId},${displayName},${sql.json(template.permissions)},${template.canExport},${new Date().toISOString()},'operator-provision')
    ON CONFLICT(property_id,email) DO UPDATE SET role=excluded.role,active=true,auth_user_id=COALESCE(excluded.auth_user_id,role_assignments.auth_user_id),display_name=excluded.display_name,workspace_permissions=excluded.workspace_permissions,can_export=excluded.can_export,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=role_assignments.version+1
  `;
  console.log(`Provisioned ${role} for ${email} on ${propertyId}.`);
} finally { await sql.end({timeout:5}); }
