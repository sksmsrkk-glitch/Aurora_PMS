/** Behavior contracts for bulk-import step-up authentication. */
import test from "node:test";
import assert from "node:assert/strict";
import { importMfaFailure } from "../app/api/import-mfa-policy.ts";

test("data imports require a verified Supabase identity",()=>{
  assert.deepEqual(importMfaFailure(null,true),{
    status:401,error:"로그인이 필요합니다.",code:"AUTH_REQUIRED",
  });
});

test("data imports require aal2 by default and accept completed step-up",()=>{
  assert.deepEqual(importMfaFailure({assuranceLevel:"aal1"},true),{
    status:403,error:"데이터 이관에는 MFA 추가 인증이 필요합니다.",code:"MFA_REQUIRED",
  });
  assert.equal(importMfaFailure({assuranceLevel:"aal2"},true),null);
});

test("controlled installations can explicitly opt out of the aal2 step-up only",()=>{
  assert.equal(importMfaFailure({assuranceLevel:"aal1"},false),null);
  assert.equal(importMfaFailure(null,false)?.code,"AUTH_REQUIRED");
});
