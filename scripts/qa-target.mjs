/** Hard gate preventing stateful QA from ever targeting the production database. */
const PRODUCTION_PROJECT_REFS = new Set([
  "tnbxreeidezidckemflb",
  ...(process.env.PMS_PRODUCTION_PROJECT_REFS || "").split(",").map(value=>value.trim()).filter(Boolean),
]);

export async function assertSafeQaTarget(baseUrl) {
  const expectedEnvironment=process.env.PMS_QA_ENVIRONMENT;
  const expectedProjectRef=process.env.PMS_QA_PROJECT_REF;
  const confirmation=process.env.PMS_QA_CONFIRM;
  if(expectedEnvironment!=="staging"||confirmation!=="AURORA_STAGING_ONLY") {
    throw new Error("Stateful QA requires PMS_QA_ENVIRONMENT=staging and PMS_QA_CONFIRM=AURORA_STAGING_ONLY");
  }
  if(!expectedProjectRef||PRODUCTION_PROJECT_REFS.has(expectedProjectRef)) {
    throw new Error("PMS_QA_PROJECT_REF must name a dedicated non-production Supabase project");
  }
  const target=new URL(baseUrl);
  if(target.hostname==="aurora-pms-gilt.vercel.app")throw new Error("Production PMS URL is forbidden for stateful QA");

  const response=await fetch(`${baseUrl}/api/health`,{headers:{accept:"application/json"}});
  const health=await response.json().catch(()=>null);
  if(!response.ok||health?.status!=="ok")throw new Error(`QA target health check failed (${response.status})`);
  if(health.environment!=="staging"||health.qaAllowed!==true)throw new Error("Target deployment has not opted into destructive staging QA");
  if(health.databaseProjectRef!==expectedProjectRef||PRODUCTION_PROJECT_REFS.has(health.databaseProjectRef)) {
    throw new Error("Target deployment is not connected to the declared isolated staging database");
  }
}
