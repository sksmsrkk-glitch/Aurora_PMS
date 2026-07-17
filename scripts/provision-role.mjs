/** Explicit operator-only PMS role provisioning; runtime and seed paths never grant roles. */
import postgres from "postgres";

const allowedRoles=new Set(["PROPERTY_ADMIN","NIGHT_AUDITOR","FRONT_DESK","CASHIER","HOUSEKEEPING","REVENUE_MANAGER","SALES_MANAGER","ACCOUNTANT","VIEWER"]);
const directUrl=process.env.DIRECT_URL||"";
const propertyId=process.env.PMS_PROVISION_PROPERTY_ID||"prop-seoul";
const email=(process.env.PMS_PROVISION_EMAIL||"").trim().toLowerCase();
const role=process.env.PMS_PROVISION_ROLE||"";
if(process.env.PMS_PROVISION_ROLE_CONFIRM!=="AURORA_PROVISION_ROLE")throw new Error("PMS_PROVISION_ROLE_CONFIRM=AURORA_PROVISION_ROLE is required");
if(!/^postgres(?:ql)?:\/\//u.test(directUrl))throw new Error("DIRECT_URL is required");
if(!/^\S+@\S+\.\S+$/u.test(email)||!allowedRoles.has(role)||!/^[A-Za-z0-9_-]{1,64}$/u.test(propertyId))throw new Error("Invalid role provisioning input");

const sql=postgres(directUrl,{max:1,prepare:false,ssl:"require",connect_timeout:15,idle_timeout:5});
try {
  await sql`
    INSERT INTO role_assignments(id,property_id,email,role,active,created_at)
    VALUES (${crypto.randomUUID()},${propertyId},${email},${role},true,${new Date().toISOString()})
    ON CONFLICT(property_id,email) DO UPDATE SET role=excluded.role,active=true
  `;
  console.log(`Provisioned ${role} for ${email} on ${propertyId}.`);
} finally { await sql.end({timeout:5}); }
