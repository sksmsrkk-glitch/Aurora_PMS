"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "로그인하지 못했습니다.");
      window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "로그인하지 못했습니다.");
    } finally { setBusy(false); }
  }

  return <main className="login-shell">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand"><Image src="/brand/aurora-mark-192.png" alt="" width={52} height={52} priority/><span><b>AURORA PMS</b><small>HOTEL OPERATIONS</small></span></div>
      <div className="login-copy"><p>WELCOME BACK</p><h1 id="login-title">호텔 운영을 시작합니다</h1><span>승인된 Aurora 계정으로 안전하게 로그인해 주세요.</span></div>
      <form onSubmit={submit}>
        <label><span>이메일</span><input type="email" autoComplete="username" required value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="name@hotel.com"/></label>
        <label><span>비밀번호</span><input type="password" autoComplete="current-password" minLength={8} required value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="8자 이상 입력"/></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "확인 중…" : "Aurora 로그인"}</button>
      </form>
      <p className="login-security">Supabase Auth · HttpOnly 보안 세션 · 역할 기반 접근 제어</p>
    </section>
  </main>;
}
