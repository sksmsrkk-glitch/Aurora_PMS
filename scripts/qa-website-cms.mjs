/** End-to-end QA for CMS projection, media lifecycle and direct-web stop sell. */
import assert from "node:assert/strict";
import { assertSafeQaTarget } from "./qa-target.mjs";

const baseUrl=(process.env.PMS_BASE_URL||"http://localhost:3000").replace(/\/$/u,"");
const addDays=(date,days)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)};
const dateParts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
const today=`${dateParts.year}-${dateParts.month}-${dateParts.day}`,arrival=addDays(today,60),departure=addDays(today,61);
const demoToken=process.env.PMS_DEMO_AUTH_TOKEN||"";
let sessionCookie="";

await assertSafeQaTarget(baseUrl);

// Production-mode staging must use a real verified Supabase Auth session. The
// token fallback remains available only for explicitly opted-in local development.
async function authenticateIfConfigured(){
  const email=process.env.PMS_TEST_EMAIL,password=process.env.PMS_TEST_PASSWORD;
  if(!email&&!password)return;
  if(!email||!password)throw new Error("PMS_TEST_EMAIL and PMS_TEST_PASSWORD must be provided together");
  const response=await fetch(`${baseUrl}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
  const body=await response.json().catch(()=>null);
  assert.equal(response.status,200,body?.error||"QA authentication failed");
  sessionCookie=response.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
  assert.ok(sessionCookie,"QA authentication did not return session cookies");
}
async function responseJson(path,options={}){const headers=new Headers(options.headers);if(sessionCookie)headers.set("cookie",sessionCookie);if(demoToken)headers.set("x-aurora-demo-token",demoToken);const response=await fetch(`${baseUrl}${path}`,{...options,headers}),body=await response.json();return {response,body};}
async function websiteAdmin(){const result=await responseJson("/api/pms?view=website");assert.equal(result.response.status,200,result.body?.error);return result.body;}
async function action(action,payload={}){const result=await responseJson("/api/pms",{method:"POST",headers:{origin:baseUrl,"content-type":"application/json","idempotency-key":`website-qa:${action}:${crypto.randomUUID()}`},body:JSON.stringify({action,...payload})});assert.equal(result.response.status,200,result.body?.error);return result.body;}
async function availability(){return responseJson(`/api/booking/availability?${new URLSearchParams({arrival,departure,adults:"2",children:"0"})}`);}
function settingsPayload(settings,overrides={}){
  return {
    version:String(settings.version),published:String(Boolean(settings.published)),hotelName:String(settings.hotel_name),brandEyebrow:String(settings.brand_eyebrow),heroTitle:String(settings.hero_title),heroSubtitle:String(settings.hero_subtitle),overviewTitle:String(settings.overview_title),overviewBody:String(settings.overview_body),experienceTitle:String(settings.experience_title),experienceBody:String(settings.experience_body),locationTitle:String(settings.location_title),locationBody:String(settings.location_body),address:String(settings.address),phone:String(settings.phone),email:String(settings.email),checkinTime:String(settings.checkin_time).slice(0,5),checkoutTime:String(settings.checkout_time).slice(0,5),
    heroMediaId:String(settings.hero_media_id||""),heroLayout:String(settings.hero_layout),heroOverlay:String(settings.hero_overlay),heroHeight:String(settings.hero_height),heroCtaLabel:String(settings.hero_cta_label),heroCtaHref:String(settings.hero_cta_href),bookingCtaLabel:String(settings.booking_cta_label),themeAccent:String(settings.theme_accent),navigationJson:JSON.stringify(settings.navigation_json),
    ...overrides,
  };
}

await authenticateIfConfigured();
const adminBefore=await websiteAdmin();
assert.equal(adminBefore.settings.published,true);
assert.ok(adminBefore.rooms.some(room=>room.published===true));
const homepage=await fetch(`${baseUrl}/hotel`),html=await homepage.text();
assert.equal(homepage.status,200);
assert.ok(html.includes(String(adminBefore.settings.hero_title)));
assert.ok(html.includes(String(adminBefore.settings.navigation_json[0].label)));
assert.ok(html.includes(`hero-layout-${String(adminBefore.settings.hero_layout).toLowerCase()}`));

const invalid=await responseJson(`/api/booking/availability?${new URLSearchParams({arrival,departure:arrival,adults:"2",children:"0"})}`);
assert.equal(invalid.response.status,400);
const before=await availability();
assert.equal(before.response.status,200,before.body?.error);
assert.ok(before.body.offers.length>0,"No published website room is available for CMS QA");
assert.ok(Object.hasOwn(before.body.offers[0],"imageUrl"));
assert.ok(Array.isArray(before.body.offers[0].amenities));
const offer=before.body.offers[0];

// Saving identical content exercises optimistic versioning without changing copy.
const settings=adminBefore.settings;
await action("update_website_settings",settingsPayload(settings));
const adminSaved=await websiteAdmin();
assert.equal(Number(adminSaved.settings.version),Number(settings.version)+1);

let webClosed=false;
try {
  const payload={from:arrival,to:arrival,roomTypeIds:JSON.stringify([offer.roomTypeId]),weekdays:JSON.stringify([0,1,2,3,4,5,6]),sellLimit:"",priceOverride:"",minStay:"",closed:"",cta:"",ctd:"",mappingId:"",channelSellRate:"",channelNetRate:""};
  await action("bulk_update_inventory_controls",{...payload,websiteClosed:"true"});webClosed=true;
  const hidden=await availability();
  assert.equal(hidden.response.status,200,hidden.body?.error);
  assert.ok(!hidden.body.offers.some(item=>item.roomTypeId===offer.roomTypeId),"WEB OFF room remained publicly bookable");
  await action("bulk_update_inventory_controls",{...payload,websiteClosed:"false"});webClosed=false;
} finally {
  if(webClosed)await action("bulk_update_inventory_controls",{from:arrival,to:arrival,roomTypeIds:JSON.stringify([offer.roomTypeId]),weekdays:JSON.stringify([0,1,2,3,4,5,6]),sellLimit:"",priceOverride:"",minStay:"",closed:"",cta:"",ctd:"",websiteClosed:"false",mappingId:"",channelSellRate:"",channelNetRate:""});
}
const restored=await availability();
assert.ok(restored.body.offers.some(item=>item.roomTypeId===offer.roomTypeId),"WEB ON did not restore the room offer");

let mediaId="",visualChanged=false;
try {
  const altText=`Website QA ${crypto.randomUUID().slice(0,8)}`;
  mediaId=crypto.randomUUID();
  await action("upload_website_media",{mediaId,scope:"HOTEL",roomTypeId:"",role:"HERO",altText,sortOrder:"999",filename:"qa-pixel.png",dataUrl:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="});
  const uploaded=(await websiteAdmin()).media.find(item=>item.alt_text===altText);
  assert.ok(uploaded,"Uploaded website media metadata is missing");assert.equal(uploaded.id,mediaId);
  const image=await fetch(uploaded.public_url);assert.equal(image.status,200);
  const beforeVisual=(await websiteAdmin()).settings;
  const alternateLayout=beforeVisual.hero_layout==="CENTER"?"LEFT":"CENTER";
  await action("update_website_settings",settingsPayload(beforeVisual,{heroMediaId:mediaId,heroLayout:alternateLayout}));visualChanged=true;
  const selected=(await websiteAdmin()).settings;
  assert.equal(selected.hero_media_id,mediaId);assert.equal(selected.hero_layout,alternateLayout);
  await action("update_website_settings",settingsPayload(selected,{heroMediaId:String(settings.hero_media_id||""),heroLayout:String(settings.hero_layout)}));visualChanged=false;
} finally {
  if(visualChanged){const current=(await websiteAdmin()).settings;await action("update_website_settings",settingsPayload(current,{heroMediaId:String(settings.hero_media_id||""),heroLayout:String(settings.hero_layout)}));}
  if(mediaId)await action("delete_website_media",{mediaId});
}
assert.ok(!(await websiteAdmin()).media.some(item=>item.id===mediaId));

console.log(JSON.stringify({homepage:homepage.status,publishedRooms:adminBefore.rooms.filter(room=>room.published===true).length,offers:before.body.offers.length,invalidDateStatus:invalid.response.status,settingsVersioned:true,visualEditor:true,heroSelection:true,webStopSell:true,webRestore:true,mediaLifecycle:true}));
