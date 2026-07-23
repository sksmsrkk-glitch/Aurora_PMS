"use client";

/** Hotel staff directory with explicit page-level read/write authorization. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { staffUserMatchesSearch } from "../lib/pms-search";
import { usePmsActions } from "./pms-action-context";
import {
  PMS_ROLES,
  ROLE_ACCESS_TEMPLATES,
  ROLE_LABELS,
  WORKSPACE_LABELS,
  type AccessMode,
  type Role,
  type WorkspaceAccess,
} from "./access-control";
import { PMS_WORKSPACES } from "./pms-workspaces";

type StaffUser={id:string;email:string;display_name:string;role:Role;active:boolean;workspace_permissions:WorkspaceAccess;can_export:boolean;must_change_password:boolean;auth_ready:boolean;version:number;created_at:string;updated_at:string;updated_by:string|null;is_self:boolean};
type StaffPayload={users:StaffUser[]};
type Draft={displayName:string;email:string;password:string;role:Role;permissions:WorkspaceAccess;canExport:boolean};

function generatedPassword(){
  const bytes=crypto.getRandomValues(new Uint8Array(18));
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  return `Aa1!${Array.from(bytes,(byte)=>alphabet[byte%alphabet.length]).join("")}`;
}

function templateDraft(role:Role="FRONT_DESK"):Draft{
  const template=ROLE_ACCESS_TEMPLATES[role];
  return {displayName:"",email:"",password:generatedPassword(),role,permissions:structuredClone(template.permissions),canExport:template.canExport};
}

async function fetchStaff(){
  const response=await fetch("/api/pms?view=users",{cache:"no-store"});
  if(response.status===401){window.location.replace("/login");throw new Error("로그인이 필요합니다.");}
  if(response.status===428){window.location.replace("/change-password");throw new Error("비밀번호 변경이 필요합니다.");}
  const body=await response.json() as StaffPayload&{error?:string};
  if(!response.ok)throw new Error(body.error||"직원 목록을 불러오지 못했습니다.");
  return body;
}

export default function StaffAccessManager({canAdmin}:{canAdmin:boolean}){
  const {busy,act}=usePmsActions();
  const [users,setUsers]=useState<StaffUser[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState("");
  const [draft,setDraft]=useState<Draft|null>(null),[editing,setEditing]=useState<StaffUser|null>(null),[resetting,setResetting]=useState<StaffUser|null>(null),[temporaryPassword,setTemporaryPassword]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError("");try{setUsers((await fetchStaff()).users);}catch(reason){setError(reason instanceof Error?reason.message:"직원 목록을 불러오지 못했습니다.");}finally{setLoading(false);}},[]);
  // The initial request synchronizes this isolated workspace with the server directory.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void load();},[load]);

  const filtered=useMemo(()=>users.filter((user)=>staffUserMatchesSearch(user,ROLE_LABELS[user.role],query)),[query,users]);
  const activeCount=users.filter((user)=>user.active).length,fullAdminCount=users.filter((user)=>user.active&&user.workspace_permissions.users==="WRITE").length;

  function applyRole(nextRole:Role){const template=ROLE_ACCESS_TEMPLATES[nextRole];setDraft((current)=>current&&({...current,role:nextRole,permissions:structuredClone(template.permissions),canExport:template.canExport}));}
  function setMode(workspace:keyof WorkspaceAccess,mode:AccessMode){setDraft((current)=>current&&({...current,permissions:{...current.permissions,[workspace]:mode}}));}
  function edit(user:StaffUser){setEditing(user);setDraft({displayName:user.display_name,email:user.email,password:"",role:user.role,permissions:structuredClone(user.workspace_permissions),canExport:user.can_export});}
  function closeEditor(){setDraft(null);setEditing(null);}

  async function save(){
    if(!draft)return;
    const ok=editing
      ?await act("update_staff_access",{assignmentId:editing.id,displayName:draft.displayName,role:draft.role,workspacePermissions:JSON.stringify(draft.permissions),canExport:String(draft.canExport),expectedVersion:String(editing.version)})
      :await act("create_staff_user",{email:draft.email,displayName:draft.displayName,password:draft.password,role:draft.role,workspacePermissions:JSON.stringify(draft.permissions),canExport:String(draft.canExport)});
    if(ok){closeEditor();await load();}
  }

  async function toggleActive(user:StaffUser){
    if(!window.confirm(`${user.display_name} 계정을 ${user.active?"접근 중지":"다시 활성화"}할까요?`))return;
    if(await act("set_staff_active",{assignmentId:user.id,active:String(!user.active),expectedVersion:String(user.version)}))await load();
  }

  async function resetPassword(){
    if(!resetting)return;
    if(await act("reset_staff_password",{assignmentId:resetting.id,password:temporaryPassword,expectedVersion:String(resetting.version)})){setResetting(null);setTemporaryPassword("");await load();}
  }

  return <>
    <section className="staff-kpis">
      <article><span>등록 계정</span><strong>{users.length}</strong><small>한 호텔에서 사용할 수 있는 ID</small></article>
      <article><span>활성 계정</span><strong>{activeCount}</strong><small>현재 로그인 가능한 배정</small></article>
      <article><span>권한 관리자</span><strong>{fullAdminCount}</strong><small>직원 권한 변경 가능</small></article>
    </section>
    <section className="panel full staff-panel">
      <div className="panel-title"><div><h2>직원 계정과 접근 권한</h2><p>페이지마다 조회와 입력·수정 권한을 독립적으로 지정합니다.</p></div>{canAdmin&&<button className="primary" onClick={()=>{setEditing(null);setDraft(templateDraft());}}>＋ 직원 계정 추가</button>}</div>
      <div className="staff-toolbar"><div className="search"><span>⌕</span><input aria-label="직원 검색" placeholder="이름, 이메일, 직무 검색" value={query} onChange={(event)=>setQuery(event.target.value)}/>{query&&<button onClick={()=>setQuery("")} aria-label="검색어 지우기">×</button>}</div><span>{filtered.length}명</span></div>
      {error&&<div className="staff-error" role="alert">{error}<button onClick={()=>void load()}>다시 시도</button></div>}
      {loading?<div className="module-loading"><b>직원 목록을 불러오고 있어요</b></div>:<div className="staff-list">
        <div className="staff-list-head"><span>직원</span><span>직무 템플릿</span><span>페이지 권한</span><span>상태</span><span>관리</span></div>
        {filtered.map((user)=>{const readable=Object.values(user.workspace_permissions).filter((mode)=>mode!=="NONE").length,writable=Object.values(user.workspace_permissions).filter((mode)=>mode==="WRITE").length;return <article key={user.id} className={!user.active?"inactive":""}>
          <button className="staff-identity" onClick={()=>edit(user)}><i>{user.display_name.slice(0,2).toUpperCase()}</i><span><b>{user.display_name}{user.is_self&&<em>나</em>}</b><small>{user.email}</small></span></button>
          <span>{ROLE_LABELS[user.role]}</span><span><b>조회 {readable}</b><small>입력·수정 {writable} · 내보내기 {user.can_export?"허용":"차단"}</small></span>
          <span className={`staff-status ${user.active?"active":"stopped"}`}>{user.active?(user.must_change_password?"비밀번호 변경 대기":"활성"):"접근 중지"}</span>
          <div><button className="secondary" onClick={()=>edit(user)}>권한 보기</button>{canAdmin&&!user.is_self&&<><button disabled={!user.auth_ready||!user.active||Boolean(busy)} onClick={()=>{setResetting(user);setTemporaryPassword(generatedPassword());}}>PW 재설정</button><button className="danger-link" disabled={Boolean(busy)} onClick={()=>void toggleActive(user)}>{user.active?"중지":"활성화"}</button></>}</div>
        </article>})}
        {!filtered.length&&<div className="empty-state large"><b>조건에 맞는 직원이 없어요</b><p>검색어를 바꾸거나 새 계정을 추가해 보세요.</p></div>}
      </div>}
    </section>

    {draft&&<div className="modal-backdrop" onMouseDown={(event)=>event.currentTarget===event.target&&closeEditor()}><section className="modal staff-editor" role="dialog" aria-modal="true" aria-label={editing?"직원 권한 편집":"직원 계정 생성"}>
      <div className="modal-head"><div><span>{editing?"ACCESS CONTROL":"NEW STAFF"}</span><h2>{editing?`${editing.display_name} 권한 편집`:"직원 계정 만들기"}</h2><p>직무 템플릿을 적용한 뒤 페이지별로 세밀하게 조정할 수 있습니다.</p></div><button onClick={closeEditor} aria-label="닫기">×</button></div>
      <div className="staff-editor-body"><div className="staff-fields"><label>직원 이름<input value={draft.displayName} disabled={!canAdmin||editing?.is_self} onChange={(event)=>setDraft({...draft,displayName:event.target.value})}/></label><label>로그인 ID (이메일)<input type="email" autoComplete="off" value={draft.email} disabled={Boolean(editing)||!canAdmin} onChange={(event)=>setDraft({...draft,email:event.target.value})}/></label>{!editing&&<label>임시 비밀번호<div className="password-field"><input type="text" autoComplete="off" value={draft.password} disabled={!canAdmin} onChange={(event)=>setDraft({...draft,password:event.target.value})}/><button type="button" onClick={()=>setDraft({...draft,password:generatedPassword()})}>새로 생성</button></div><small>직원은 최초 로그인 직후 반드시 새 비밀번호로 변경합니다.</small></label>}<label>직무 템플릿<select value={draft.role} disabled={!canAdmin||editing?.is_self} onChange={(event)=>applyRole(event.target.value as Role)}>{PMS_ROLES.map((item)=><option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select></label></div>
        <div className="permission-matrix"><div><b>페이지 접근 매트릭스</b><span>없음은 메뉴·API 모두 차단됩니다.</span></div>{PMS_WORKSPACES.map((workspace)=><label key={workspace}><span><b>{WORKSPACE_LABELS[workspace]}</b><small>{workspace}</small></span><select aria-label={`${WORKSPACE_LABELS[workspace]} 권한`} value={draft.permissions[workspace]} disabled={!canAdmin||editing?.is_self} onChange={(event)=>setMode(workspace,event.target.value as AccessMode)}><option value="NONE">접근 없음</option><option value="READ">조회</option><option value="WRITE">입력·수정</option></select></label>)}<label className="export-permission"><span><b>리포트 파일 내보내기</b><small>개인정보가 포함된 XLSX/CSV 출력 권한</small></span><input type="checkbox" checked={draft.canExport} disabled={!canAdmin||editing?.is_self} onChange={(event)=>setDraft({...draft,canExport:event.target.checked})}/></label></div>
      </div>
      <div className="modal-actions"><button className="secondary" onClick={closeEditor}>닫기</button>{canAdmin&&!editing?.is_self&&<button className="primary" disabled={Boolean(busy)} onClick={()=>void save()}>{busy?"저장 중…":editing?"권한 저장":"계정 생성"}</button>}</div>
    </section></div>}

    {resetting&&<div className="modal-backdrop" onMouseDown={(event)=>event.currentTarget===event.target&&setResetting(null)}><section className="modal password-reset-modal" role="dialog" aria-modal="true" aria-label="임시 비밀번호 재설정"><div className="modal-head"><div><span>RESET PASSWORD</span><h2>{resetting.display_name} 임시 비밀번호</h2><p>전달 후 이 화면을 닫으세요. 비밀번호 원문은 저장되지 않습니다.</p></div><button onClick={()=>setResetting(null)} aria-label="닫기">×</button></div><label>새 임시 비밀번호<div className="password-field"><input value={temporaryPassword} onChange={(event)=>setTemporaryPassword(event.target.value)}/><button type="button" onClick={()=>setTemporaryPassword(generatedPassword())}>새로 생성</button></div></label><small>다음 로그인 후 직원이 직접 새 비밀번호로 교체해야 합니다.</small><div className="modal-actions"><button className="secondary" onClick={()=>setResetting(null)}>취소</button><button className="primary" disabled={Boolean(busy)} onClick={()=>void resetPassword()}>{busy?"재설정 중…":"비밀번호 재설정"}</button></div></section></div>}
  </>;
}
