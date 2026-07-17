/** Behavioral tests for the shared visual-editor publishing contract. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAccentColor,
  normalizeHeroCtaHref,
  normalizeWebsiteNavigation,
  validateWebsiteNavigation,
} from "../app/website-editor-contract.ts";

test("navigation normalization keeps a safe unique set in the configured order",()=>{
  assert.deepEqual(normalizeWebsiteNavigation([
    {id:"location",label:"오시는 길",enabled:true},
    {id:"stay",label:"객실",enabled:false},
    {id:"location",label:"duplicate",enabled:true},
    {id:"javascript:alert(1)",label:"unsafe",enabled:true},
  ]),[
    {id:"location",label:"오시는 길",enabled:true},
    {id:"stay",label:"객실",enabled:false},
    {id:"experience",label:"EXPERIENCE",enabled:true},
  ]);
});

test("publishing rejects missing, duplicate and fully hidden sections",()=>{
  assert.throws(()=>validateWebsiteNavigation([{id:"stay",label:"Stay",enabled:true}]),/3개 섹션/u);
  assert.throws(()=>validateWebsiteNavigation([
    {id:"stay",label:"Stay",enabled:true},{id:"stay",label:"Again",enabled:true},{id:"location",label:"Location",enabled:true},
  ]),/중복 없이/u);
  assert.throws(()=>validateWebsiteNavigation([
    {id:"stay",label:"Stay",enabled:false},{id:"experience",label:"Experience",enabled:false},{id:"location",label:"Location",enabled:false},
  ]),/하나 이상/u);
});

test("visual tokens cannot inject arbitrary colors or links",()=>{
  assert.equal(normalizeAccentColor("#12abEF"),"#12ABEF");
  assert.equal(normalizeAccentColor("red; background:url(x)"),"#2764E7");
  assert.equal(normalizeHeroCtaHref("/hotel/book"),"/hotel/book");
  assert.equal(normalizeHeroCtaHref("javascript:alert(1)"),"#stay");
});
