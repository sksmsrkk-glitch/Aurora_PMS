import assert from "node:assert/strict";

const baseUrl=(process.env.PMS_BASE_URL||"http://localhost:3000").replace(/\/$/u,"");
const addDays=(date,days)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)};
const todayParts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
const today=`${todayParts.year}-${todayParts.month}-${todayParts.day}`;
const arrival=addDays(today,1),departure=addDays(today,2);
const availabilityPath=`/api/booking/availability?${new URLSearchParams({arrival,departure,adults:"2",children:"0"})}`;

async function json(path,options){
  const response=await fetch(`${baseUrl}${path}`,options);
  const body=await response.json();
  return {response,body};
}

const rejectedOrigin=await json("/api/booking/reservations",{method:"POST",headers:{origin:"https://attacker.invalid","content-type":"application/json","idempotency-key":`origin:${crypto.randomUUID()}`},body:"{}"});
assert.equal(rejectedOrigin.response.status,403);
const missingKey=await json("/api/booking/reservations",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
assert.equal(missingKey.response.status,400);

const before=await json(availabilityPath);
assert.equal(before.response.status,200,before.body?.error);
assert.ok(before.body.offers.length>0,"No public offers available for booking QA");
const offer=before.body.offers[0];
const suffix=crypto.randomUUID().replaceAll("-","").slice(0,12);
const email=`booking.qa.${suffix}@example.com`;
const lastName=`QA${suffix.slice(0,7)}`;
const idempotencyKey=`booking-qa:${suffix}`;
const payload={arrival,departure,adults:2,children:0,roomTypeId:offer.roomTypeId,firstName:"Aurora",lastName,email,phone:"010-0000-0000",specialRequests:"Automated booking engine verification"};
const headers={"content-type":"application/json","idempotency-key":idempotencyKey};

const created=await json("/api/booking/reservations",{method:"POST",headers,body:JSON.stringify(payload)});
assert.equal(created.response.status,201,created.body?.error);
assert.equal(created.body.duplicate,false);
const replay=await json("/api/booking/reservations",{method:"POST",headers,body:JSON.stringify(payload)});
assert.equal(replay.response.status,200,replay.body?.error);
assert.equal(replay.body.duplicate,true);
assert.equal(replay.body.reservationId,created.body.reservationId);

const cancellationPayload={confirmation:created.body.confirmation,email,lastName};
const cancelled=await json("/api/booking/reservations",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify(cancellationPayload)});
assert.equal(cancelled.response.status,200,cancelled.body?.error);
assert.equal(cancelled.body.duplicate,false);
const cancelReplay=await json("/api/booking/reservations",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify(cancellationPayload)});
assert.equal(cancelReplay.response.status,200,cancelReplay.body?.error);
assert.equal(cancelReplay.body.duplicate,true);

const after=await json(availabilityPath);
assert.equal(after.response.status,200,after.body?.error);
const restored=after.body.offers.find(item=>item.roomTypeId===offer.roomTypeId);
assert.ok(restored,"Cancelled room type did not return to availability");
assert.equal(restored.available,offer.available);
console.log(JSON.stringify({availabilityStatus:before.response.status,offers:before.body.offers.length,createStatus:created.response.status,replayStatus:replay.response.status,sameReservation:true,cancelStatus:cancelled.response.status,cancelReplayStatus:cancelReplay.response.status,inventoryRestored:true,crossOriginStatus:rejectedOrigin.response.status,missingIdempotencyStatus:missingKey.response.status}));
