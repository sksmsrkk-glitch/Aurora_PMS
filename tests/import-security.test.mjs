/** Behavior contracts for bulk-import step-up authentication. */
import test from "node:test";
import assert from "node:assert/strict";
import { importMfaFailure } from "../app/api/import-mfa-policy.ts";
import {
  importAccessFailure,
  requiredImportCapability,
} from "../app/api/import-access-policy.ts";

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

test("both import routes share one kind-specific capability policy",()=>{
  assert.equal(requiredImportCapability("RESERVATIONS"),"RESERVATION_WRITE");
  assert.equal(requiredImportCapability("ROOMS"),"USER_ADMIN");
  assert.equal(importAccessFailure({capabilities:["RESERVATION_WRITE"],identity:{assuranceLevel:"aal2"},kind:"RESERVATIONS"}),null);
  assert.equal(importAccessFailure({capabilities:["USER_ADMIN"],identity:{assuranceLevel:"aal2"},kind:"ROOMS"}),null);
  assert.equal(importAccessFailure({capabilities:["RESERVATION_WRITE"],identity:{assuranceLevel:"aal2"},kind:"ROOMS"})?.code,"IMPORT_PERMISSION_REQUIRED");
  assert.equal(importAccessFailure({capabilities:["USER_ADMIN"],identity:{assuranceLevel:"aal2"},kind:"RESERVATIONS"})?.code,"IMPORT_PERMISSION_REQUIRED");
});
