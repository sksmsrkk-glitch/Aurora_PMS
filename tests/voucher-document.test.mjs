/** Behavior checks for real voucher artifacts, including Korean PDF font embedding. */
import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { buildVoucherPdf, buildVoucherWorkbook, renderVoucherHtml } from "../app/api/pms/voucher-document.ts";

const payload=(amountVisible)=>({language:"KO",amountVisible,issuedAt:"2030-01-01T00:00:00.000Z",hotel:{name:"탈로스 호텔",code:"TL",address:"서울특별시 종로구",phone:"1688-8376",email:"talos@allmytour.com",currency:"KRW",checkinTime:"15:00",checkoutTime:"11:00"},reservation:{id:"reservation-1",confirmationNo:"TEST-1",status:"DUE_IN",bookerName:"예약자",bookerPhone:"",bookerEmail:"booker@example.com",guestName:"홍길동",guestPhone:"",guestEmail:"guest@example.com",arrivalDate:"2030-01-01",departureDate:"2030-01-02",nights:1,roomType:"DLX · 디럭스",roomNumber:"101",productName:"조식 패키지",productCode:"BAR",mealPlan:"BREAKFAST",adults:2,children:0,source:"Direct",paymentType:"HOTEL",guestRequest:"고층 요청",inclusions:["조식"],cancellationPolicy:"체크인 3일 전 무료",cancellationTerms:[{basis:"체크인 3일 전",feePercent:0}]},rateNights:[{stayDate:"2030-01-01",rate:180000,currency:"KRW",ratePlan:"BAR"}],totalAmount:180000});

test("KR voucher renders a valid embedded-font PDF and workbook",async()=>{
  const document=payload(true),pdf=await buildVoucherPdf(document),workbook=buildVoucherWorkbook(document),files=unzipSync(workbook);
  assert.equal(new TextDecoder().decode(pdf.slice(0,4)),"%PDF");
  assert.ok(pdf.length>10_000);
  assert.ok(workbook.length>1_000);
  assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]),/180000/u);
  assert.match(renderVoucherHtml(document),/예약 확인서/u);
});

test("amount-hidden voucher omits prices from every rendered surface",()=>{
  const document=payload(false),html=renderVoucherHtml(document),files=unzipSync(buildVoucherWorkbook(document)),sheet=strFromU8(files["xl/worksheets/sheet2.xml"]);
  assert.doesNotMatch(html,/180,000|₩180/u);
  assert.doesNotMatch(sheet,/180000|금액/u);
});
