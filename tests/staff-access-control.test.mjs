/** Behavioral contracts for page-level hotel staff authorization. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesForAccess,
  parseWorkspaceAccess,
  ROLE_ACCESS_TEMPLATES,
} from "../app/access-control.ts";
import { PMS_WORKSPACES } from "../app/pms-workspaces.ts";
import { registrationFor } from "../app/api/pms/action-registry.ts";
import { handleStaffAction, validateStaffPassword } from "../app/api/pms/staff.ts";
import { compilePostgresParameters } from "../db/postgres-parameters.mjs";

test("every role template explicitly covers every PMS workspace",()=>{
  for(const [role,template] of Object.entries(ROLE_ACCESS_TEMPLATES)){
    assert.deepEqual(Object.keys(template.permissions).sort(),[...PMS_WORKSPACES].sort(),role);
    assert.ok(parseWorkspaceAccess(template.permissions),role);
  }
});

test("permission parser fails closed on partial, unknown, or invalid maps",()=>{
  assert.equal(parseWorkspaceAccess({overview:"READ"}),null);
  assert.equal(parseWorkspaceAccess({...ROLE_ACCESS_TEMPLATES.VIEWER.permissions,secret:"WRITE"}),null);
  assert.equal(parseWorkspaceAccess({...ROLE_ACCESS_TEMPLATES.VIEWER.permissions,rooms:"OWNER"}),null);
  assert.equal(parseWorkspaceAccess("not-json"),null);
});

test("property admin has all write capabilities while viewer cannot mutate or export",()=>{
  const admin=capabilitiesForAccess(ROLE_ACCESS_TEMPLATES.PROPERTY_ADMIN.permissions,true);
  for(const capability of ["RESERVATION_WRITE","INVENTORY_WRITE","WEBSITE_WRITE","MASTER_WRITE","USER_ADMIN","EOD_RUN","REPORT_EXPORT"])assert.ok(admin.includes(capability),capability);
  const viewer=capabilitiesForAccess(ROLE_ACCESS_TEMPLATES.VIEWER.permissions,false);
  assert.deepEqual(viewer,["READ"]);
});

test("sensitive actions require their page-specific server capability",()=>{
  assert.equal(registrationFor("create_staff_user")?.capability,"USER_ADMIN");
  assert.equal(registrationFor("update_website_settings")?.capability,"WEBSITE_WRITE");
  assert.equal(registrationFor("create_room_type")?.capability,"MASTER_WRITE");
  assert.equal(registrationFor("export_report")?.capability,"REPORT_EXPORT");
});

test("temporary passwords enforce length and character diversity",()=>{
  assert.equal(validateStaffPassword("Strong-Staff-123"),"Strong-Staff-123");
  assert.throws(()=>validateStaffPassword("short"),/12자/u);
  assert.throws(()=>validateStaffPassword("abcdefghijklmnop"),/3종/u);
});

test("staff update and activation batches have exact SQL bind counts",async()=>{
  const target={id:"assignment-1",email:"other@example.com",display_name:"Other Staff",role:"VIEWER",workspace_permissions:ROLE_ACCESS_TEMPLATES.VIEWER.permissions,can_export:false,active:true,version:3,auth_user_id:null};
  const database={
    forProperty(){return this;},findActiveRoleAssignments:async()=>[],
    prepare(query){return {query,values:[],bind(...values){this.values=values;return this;},first:async()=>query.startsWith("SELECT * FROM role_assignments")?target:null,all:async()=>({results:[],success:true,meta:{changes:0}}),run:async()=>({results:[],success:true,meta:{changes:1}})};},
    async batch(statements){for(const statement of statements)compilePostgresParameters(statement.query,statement.values.length);return statements.map(()=>({results:[],success:true,meta:{changes:1}}));},
  };
  const principal={email:"admin@example.com",displayName:"Admin",role:"PROPERTY_ADMIN",capabilities:["USER_ADMIN"],propertyId:"prop-seoul",workspaceAccess:ROLE_ACCESS_TEMPLATES.PROPERTY_ADMIN.permissions,canExport:true,mustChangePassword:false};
  await handleStaffAction(database,{action:"set_staff_active",assignmentId:target.id,active:"false",expectedVersion:"3"},principal,new Date().toISOString(),"staff-active-test");
  await handleStaffAction(database,{action:"update_staff_access",assignmentId:target.id,displayName:"Updated Staff",role:"VIEWER",workspacePermissions:JSON.stringify(ROLE_ACCESS_TEMPLATES.VIEWER.permissions),canExport:"false",expectedVersion:"3"},principal,new Date().toISOString(),"staff-access-test");
});
