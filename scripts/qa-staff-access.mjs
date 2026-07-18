/** Staging-only E2E for staff creation, first-password gate, RBAC, and revocation. */
import assert from "node:assert/strict";

const base=(process.env.PMS_BASE_URL||"").replace(/\/$/u,"");
const adminEmail=(process.env.PMS_TEST_EMAIL||"").trim().toLowerCase();
const adminPassword=process.env.PMS_TEST_PASSWORD||"";
const staffEmail=(process.env.PMS_QA_STAFF_EMAIL||"").trim().toLowerCase();
const staffPassword=process.env.PMS_QA_STAFF_PASSWORD||"";
if(!base||!adminEmail||!adminPassword||!staffEmail||!staffPassword)throw new Error("PMS_BASE_URL, PMS_TEST_EMAIL/PASSWORD and PMS_QA_STAFF_EMAIL/PASSWORD are required");

async function jsonRequest(path,{method="GET",cookie="",body,expected}={}){
  const response=await fetch(`${base}${path}`,{method,headers:{...(cookie?{cookie}:{}),...(body?{"content-type":"application/json","idempotency-key":crypto.randomUUID(),origin:base}:{})},body:body?JSON.stringify(body):undefined,redirect:"manual"});
  let payload={};try{payload=await response.json();}catch{/* Status is asserted separately. */}
  if(expected!==undefined)assert.equal(response.status,expected,payload?.error||path);
  return {response,payload};
}

function sessionCookie(response){
  const values=typeof response.headers.getSetCookie==="function"?response.headers.getSetCookie():[response.headers.get("set-cookie")||""];
  return values.filter(Boolean).map((value)=>value.split(";",1)[0]).join("; ");
}

const health=await jsonRequest("/api/health",{expected:200});
assert.equal(health.payload.environment,"staging","Stateful staff QA is staging-only");
assert.equal(health.payload.qaAllowed,true,"Staging must explicitly allow QA");

const login=await jsonRequest("/api/auth/login",{method:"POST",body:{email:adminEmail,password:adminPassword},expected:200});
const adminCookie=sessionCookie(login.response);assert.ok(adminCookie,"Admin session cookie missing");
const before=await jsonRequest("/api/pms?view=users",{cookie:adminCookie,expected:200});

const workspaces=["overview","frontdesk","inventory","website","groups","finance","accounting","channels","rooms","reports","master","revenue","users","audit"];
const workspacePermissions=Object.fromEntries(workspaces.map((workspace)=>[workspace,workspace==="rooms"?"READ":"NONE"]));
await jsonRequest("/api/pms",{method:"POST",cookie:adminCookie,expected:200,body:{action:"create_staff_user",email:staffEmail,displayName:"QA Read Only",password:staffPassword,role:"HOUSEKEEPING",workspacePermissions:JSON.stringify(workspacePermissions),canExport:"false"}});
const directory=await jsonRequest("/api/pms?view=users",{cookie:adminCookie,expected:200});
const assignment=directory.payload.users.find((user)=>user.email===staffEmail);assert.ok(assignment,"Created staff assignment missing");

try{
  const staffLogin=await jsonRequest("/api/auth/login",{method:"POST",body:{email:staffEmail,password:staffPassword},expected:200});
  const staffCookie=sessionCookie(staffLogin.response);assert.ok(staffCookie,"Staff session cookie missing");
  await jsonRequest("/api/pms?view=core",{cookie:staffCookie,expected:428});
  const changedPassword=`Nx!${crypto.randomUUID().replaceAll("-","")}4`;
  await jsonRequest("/api/auth/change-password",{method:"POST",cookie:staffCookie,body:{password:changedPassword,confirmation:changedPassword},expected:200});
  const core=await jsonRequest("/api/pms?view=core",{cookie:staffCookie,expected:200});
  assert.ok(core.payload.rooms.length>0,"Rooms READ should return rooms");
  assert.equal(core.payload.reservations.length,0,"Rooms-only core must redact reservations");
  assert.equal(core.payload.inventory.types.length,0,"Rooms-only core must redact inventory");
  await jsonRequest("/api/pms?view=users",{cookie:staffCookie,expected:403});
  await jsonRequest("/api/pms?view=accounting",{cookie:staffCookie,expected:403});
  await jsonRequest("/api/pms",{method:"POST",cookie:staffCookie,expected:403,body:{action:"housekeeping",roomId:core.payload.rooms[0].id,status:"CLEAN"}});
  // First-password completion increments the assignment version. Refresh before
  // the administrator changes state so optimistic concurrency remains meaningful.
  const refreshedDirectory=await jsonRequest("/api/pms?view=users",{cookie:adminCookie,expected:200});
  const refreshedAssignment=refreshedDirectory.payload.users.find((user)=>user.id===assignment.id);assert.ok(refreshedAssignment);
  await jsonRequest("/api/pms",{method:"POST",cookie:adminCookie,expected:200,body:{action:"set_staff_active",assignmentId:assignment.id,active:"false",expectedVersion:String(refreshedAssignment.version)}});
  let revoked=0;
  for(let attempt=0;attempt<8;attempt+=1){await new Promise((resolve)=>setTimeout(resolve,900));revoked=(await jsonRequest("/api/pms?view=core",{cookie:staffCookie})).response.status;if(revoked===401)break;}
  assert.equal(revoked,401,"Deactivated assignment must revoke PMS access within the cache TTL");
  console.log(`Staff access QA passed: directory ${before.payload.users.length}, password gate 428, read 200, denied 403, revoked 401.`);
}catch(error){
  // Best-effort deactivation prevents a failed QA run from leaving an active account.
  const latest=await jsonRequest("/api/pms?view=users",{cookie:adminCookie});
  const row=latest.payload?.users?.find?.((user)=>user.email===staffEmail);
  if(row?.active)await jsonRequest("/api/pms",{method:"POST",cookie:adminCookie,body:{action:"set_staff_active",assignmentId:row.id,active:"false",expectedVersion:String(row.version)}});
  throw error;
}
