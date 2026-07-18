"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";

export default function ChangePasswordPage(){
  const [password,setPassword]=useState(""),[confirmation,setConfirmation]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{
      const response=await fetch("/api/auth/change-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password,confirmation})});
      const body=await response.json() as {ok?:boolean;error?:string};
      if(!response.ok)throw new Error(body.error||"비밀번호를 변경하지 못했습니다.");
      window.location.replace("/overview");
    }catch(reason){setError(reason instanceof Error?reason.message:"비밀번호를 변경하지 못했습니다.");setBusy(false);}
  }
  return <main className="password-change-page"><form className="password-change-card" onSubmit={submit}>
    <Image src="/brand/aurora-mark-192.png" width={56} height={56} alt="Aurora PMS"/>
    <p>AURORA PMS</p><h1>새 비밀번호를 설정해 주세요</h1>
    <span>관리자가 발급한 임시 비밀번호는 최초 로그인 후 교체해야 합니다. 비밀번호 원문은 Aurora PMS에 저장되지 않습니다.</span>
    <label>새 비밀번호<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event)=>setPassword(event.target.value)} required/></label>
    <small>12자 이상 · 영문 대/소문자, 숫자, 특수문자 중 3종 이상</small>
    <label>새 비밀번호 확인<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} required/></label>
    {error&&<div role="alert">{error}</div>}
    <button className="primary" disabled={busy}>{busy?"변경 중…":"비밀번호 변경하고 시작"}</button>
  </form></main>;
}
