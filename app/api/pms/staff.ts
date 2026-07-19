/** Tenant-scoped staff directory and account-management commands. */
import type { PmsDatabase } from "../../../db/pms-database";
import { isRole, parseWorkspaceAccess, type Role, type WorkspaceAccess } from "../../access-control";
import type { Principal } from "./auth";
import { invalidatePrincipalCache } from "./auth";
import { createStaffAuthUser, deleteStaffAuthUser, StaffAuthError, updateStaffAuthUser } from "./staff-auth";

export class StaffAccessError extends Error{
  constructor(readonly status:number,message:string){super(message);this.name="StaffAccessError";}
}

type StaffRow={id:string;email:string;display_name:string;role:Role;active:boolean;workspace_permissions:WorkspaceAccess;can_export:boolean;must_change_password:boolean;auth_ready:boolean;version:number;created_at:string;updated_at:string;updated_by:string|null;is_self:boolean};

export async function loadStaffUsers(db:PmsDatabase,principal:Principal){
  const rows=await db.prepare(`SELECT id,email,display_name,role,active,workspace_permissions,can_export,must_change_password,
    (auth_user_id IS NOT NULL) auth_ready,version,created_at,updated_at,updated_by,
    (lower(email)=lower(?)) is_self
    FROM role_assignments WHERE property_id=pms_current_property_id()
    ORDER BY active DESC,display_name,email`).bind(principal.email).all<StaffRow>();
  const users=principal.principalType==="SUPPORT"&&principal.piiMode==="MASKED"
    ?rows.results.map(row=>({...row,email:"masked@support.invalid",display_name:`${row.display_name.slice(0,1)}**`,updated_by:row.updated_by?"마스킹됨":null}))
    :rows.results;
  return {users,roles:["PROPERTY_ADMIN","NIGHT_AUDITOR","FRONT_DESK","CASHIER","HOUSEKEEPING","REVENUE_MANAGER","SALES_MANAGER","ACCOUNTANT","VIEWER"]};
}

function normalizedEmail(value:unknown){
  const email=String(value||"").trim().toLowerCase();
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))throw new StaffAccessError(400,"올바른 이메일 아이디를 입력해 주세요.");
  return email;
}

function displayName(value:unknown){
  const name=String(value||"").trim();
  if(name.length<2||name.length>80)throw new StaffAccessError(400,"직원 이름은 2~80자로 입력해 주세요.");
  return name;
}

export function validateStaffPassword(value:unknown){
  const password=String(value||"");
  const groups=[/[a-z]/u,/[A-Z]/u,/\d/u,/[^A-Za-z0-9]/u].filter((pattern)=>pattern.test(password)).length;
  if(password.length<12||password.length>128||groups<3)throw new StaffAccessError(400,"비밀번호는 12자 이상이며 영문 대·소문자, 숫자, 특수문자 중 3종 이상을 포함해야 합니다.");
  return password;
}

function role(value:unknown){if(!isRole(value))throw new StaffAccessError(400,"지원하는 직무 템플릿을 선택해 주세요.");return value;}
function permissions(value:unknown){const parsed=parseWorkspaceAccess(value);if(!parsed)throw new StaffAccessError(400,"모든 페이지의 접근 모드를 올바르게 지정해 주세요.");if(Object.values(parsed).every((mode)=>mode==="NONE"))throw new StaffAccessError(400,"최소 한 페이지의 조회 권한이 필요합니다.");return parsed;}
const bool=(value:unknown)=>value===true||value==="true";
const idempotency=(db:PmsDatabase,key:string,action:string,actor:string,now:string)=>db.prepare("INSERT INTO idempotency_keys VALUES (?, pms_current_property_id(), ?, ?, ?)").bind(key,action,actor,now);

async function targetFor(db:PmsDatabase,id:string){
  return db.prepare("SELECT * FROM role_assignments WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>();
}

export async function handleStaffAction(db:PmsDatabase,body:Record<string,string>,principal:Principal,now:string,idempotencyKey:string){
  const actor=principal.email;
  if(body.action==="create_staff_user"){
    const email=normalizedEmail(body.email),name=displayName(body.displayName),selectedRole=role(body.role),access=permissions(body.workspacePermissions),canExport=bool(body.canExport),password=validateStaffPassword(body.password);
    const exists=await db.prepare("SELECT id FROM role_assignments WHERE lower(email)=lower(?) AND property_id=pms_current_property_id()").bind(email).first();
    if(exists)throw new StaffAccessError(409,"이 호텔에 이미 등록된 이메일입니다.");
    const usage=await db.prepare("SELECT s.user_limit,(SELECT COUNT(*) FROM role_assignments ra WHERE ra.property_id=pms_current_property_id() AND ra.active) active_users FROM property_subscriptions s WHERE s.property_id=pms_current_property_id() LIMIT 1").first<{user_limit:number|null;active_users:number}>();
    if(usage?.user_limit!=null&&Number(usage.active_users)>=Number(usage.user_limit))throw new StaffAccessError(409,"현재 요금제의 활성 사용자 수 한도를 초과합니다.");
    const authUserId=await createStaffAuthUser(email,password,name);
    const assignmentId=crypto.randomUUID();
    try{
      await db.batch([
        db.prepare("INSERT INTO role_assignments(id,property_id,email,role,active,created_at,auth_user_id,display_name,workspace_permissions,can_export,must_change_password,version,updated_at,updated_by) VALUES (?,pms_current_property_id(),?,?,true,?,?,?,?,?,true,1,?,?)").bind(assignmentId,email,selectedRole,now,authUserId,name,access,canExport,now,actor),
        db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'CREATE_STAFF_USER','role_assignment',?,NULL,?,?)").bind(crypto.randomUUID(),actor,assignmentId,{email,displayName:name,role:selectedRole,workspacePermissions:access,canExport,active:true,mustChangePassword:true},now),
        idempotency(db,idempotencyKey,body.action,actor,now),
      ]);
    }catch(error){await deleteStaffAuthUser(authUserId);throw error;}
    invalidatePrincipalCache(email);
    return true;
  }

  const target=await targetFor(db,String(body.assignmentId||""));
  if(!target)throw new StaffAccessError(404,"직원 계정을 찾지 못했습니다.");
  const targetEmail=String(target.email).toLowerCase();
  if(targetEmail===actor.toLowerCase())throw new StaffAccessError(409,"자신의 권한·활성 상태·임시 비밀번호는 다른 권한 관리자가 변경해야 합니다.");
  if(Number(body.expectedVersion)!==Number(target.version))throw new StaffAccessError(409,"다른 관리자가 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.");

  if(body.action==="update_staff_access"){
    const name=displayName(body.displayName),selectedRole=role(body.role),access=permissions(body.workspacePermissions),canExport=bool(body.canExport);
    await db.batch([
      db.prepare("UPDATE role_assignments SET display_name=?,role=?,workspace_permissions=?,can_export=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(name,selectedRole,access,canExport,now,actor,target.id,target.version),
      db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'UPDATE_STAFF_ACCESS','role_assignment',?,?,?,?)").bind(crypto.randomUUID(),actor,target.id,{displayName:target.display_name,role:target.role,workspacePermissions:target.workspace_permissions,canExport:target.can_export},{displayName:name,role:selectedRole,workspacePermissions:access,canExport},now),
      idempotency(db,idempotencyKey,body.action,actor,now),
    ]);
    invalidatePrincipalCache(targetEmail);
    return true;
  }

  if(body.action==="set_staff_active"){
    const active=bool(body.active);
    await db.batch([
      db.prepare("UPDATE role_assignments SET active=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(active,now,actor,target.id,target.version),
      db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'SET_STAFF_ACTIVE','role_assignment',?,?,?,?)").bind(crypto.randomUUID(),actor,target.id,{active:target.active},{active},now),
      idempotency(db,idempotencyKey,body.action,actor,now),
    ]);
    invalidatePrincipalCache(targetEmail);
    return true;
  }

  if(body.action==="reset_staff_password"){
    const password=validateStaffPassword(body.password),authUserId=String(target.auth_user_id||"");
    if(!authUserId)throw new StaffAccessError(409,"기존 Auth 사용자 연결 정보가 없습니다. 운영 담당자가 계정 연결을 먼저 확인해야 합니다.");
    await updateStaffAuthUser(authUserId,{password});
    await db.batch([
      db.prepare("UPDATE role_assignments SET must_change_password=true,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(now,actor,target.id,target.version),
      db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'RESET_STAFF_PASSWORD','role_assignment',?,NULL,?,?)").bind(crypto.randomUUID(),actor,target.id,{mustChangePassword:true},now),
      idempotency(db,idempotencyKey,body.action,actor,now),
    ]);
    invalidatePrincipalCache(targetEmail);
    return true;
  }
  return false;
}

export { StaffAuthError };
