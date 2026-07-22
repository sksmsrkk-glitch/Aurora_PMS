/** HotelStory-compatible banquet, stay-operation, and member domain service. */
import { randomBytes, scryptSync } from "node:crypto";
import type { PmsDatabase } from "../../../db/pms-database";
import type { Principal } from "./auth";
import { phoneDigits, sqlCompactPattern, sqlLikePattern, sqlPhonePattern } from "../../../lib/search";

const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/u;
const CLOCK_TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export class FinalOperationsError extends Error {
  constructor(readonly status:number,message:string){super(message);this.name="FinalOperationsError";}
}

function bounded(value:string|null,max:number){return (value||"").trim().slice(0,max);}
function dateParam(value:string|null,fallback:string){return value&&ISO_DATE.test(value)?value:fallback;}
function bool(value:unknown){return value===true||value==="true";}
function integer(value:unknown,min:number,max:number,label:string){const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new FinalOperationsError(400,`${label} 값을 확인해 주세요.`);return parsed;}
function money(value:unknown,label:string){const parsed=Number(value);if(!Number.isFinite(parsed)||parsed<0||parsed>999_999_999_999)throw new FinalOperationsError(400,`${label} 금액을 확인해 주세요.`);return Math.round(parsed*100)/100;}
function requiredText(value:unknown,min:number,max:number,label:string){const parsed=String(value||"").trim();if(parsed.length<min||parsed.length>max)throw new FinalOperationsError(400,`${label}은(는) ${min}~${max}자로 입력해 주세요.`);return parsed;}
function expectedVersion(value:unknown){return integer(value,1,2_147_483_647,"버전");}
const idempotency=(db:PmsDatabase,key:string,action:string,actor:string,now:string)=>db.prepare("INSERT INTO idempotency_keys VALUES (?,pms_current_property_id(),?,?,?)").bind(key,action,actor,now);

/** Returns the three HotelStory-style operational views through one bounded query contract. */
export async function loadStayOperations(db:PmsDatabase,params:URLSearchParams){
  const property=await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>();
  const businessDate=String(property?.business_date||new Date().toISOString().slice(0,10));
  const mode=["checkin","checkout","occupancy"].includes(params.get("mode")||"")?String(params.get("mode")):"checkin";
  const selectedDate=dateParam(params.get("date"),businessDate),q=bounded(params.get("q"),120).toLocaleLowerCase("ko-KR"),source=bounded(params.get("source"),80),roomTypeId=bounded(params.get("roomTypeId"),80),ratePlan=bounded(params.get("ratePlan"),40).toUpperCase();
  const filters:string[]=["r.property_id=pms_current_property_id()"],binds:unknown[]=[];
  if(mode==="checkin"){filters.push("r.status='DUE_IN' AND r.arrival_date=?");binds.push(selectedDate);}
  if(mode==="checkout"){filters.push("r.status='IN_HOUSE' AND r.departure_date<=?");binds.push(selectedDate);}
  if(mode==="occupancy"){filters.push("r.status IN ('DUE_IN','IN_HOUSE') AND r.arrival_date<?::date+18 AND r.departure_date>?");binds.push(selectedDate,selectedDate);}
  if(q){const digits=phoneDigits(q);filters.push("(LOWER(CONCAT_WS(' ',r.confirmation_no,g.first_name,g.last_name,COALESCE(g.phone,''),COALESCE(rm.number,''))) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(g.last_name,'')||COALESCE(g.first_name,'')) LIKE ? ESCAPE '\\' OR (?<>'' AND REGEXP_REPLACE(COALESCE(g.phone,''),'\\D','','g') LIKE ? ESCAPE '\\'))");binds.push(sqlLikePattern(q),sqlCompactPattern(q),digits,sqlPhonePattern(q));}
  if(source){filters.push("LOWER(r.source)=LOWER(?)");binds.push(source);}
  if(roomTypeId){filters.push("r.room_type_id=?");binds.push(roomTypeId);}
  if(ratePlan){filters.push("r.rate_plan=?");binds.push(ratePlan);}
  const [reservations,rooms,types,plans,sources]=await db.batch([
    db.prepare(`SELECT r.id,r.confirmation_no,r.arrival_date,r.departure_date,r.status,r.source,r.rate_plan,r.room_id,r.room_type_id,r.eta,r.adults,r.children,r.version,g.first_name,g.last_name,g.phone,rm.number room_number,rt.code room_type_code,rt.name room_type_name,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id AND g.property_id=r.property_id JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id LEFT JOIN rooms rm ON rm.id=r.room_id AND rm.property_id=r.property_id LEFT JOIN folio_entries f ON f.reservation_id=r.id AND f.property_id=r.property_id WHERE ${filters.join(" AND ")} GROUP BY r.id,g.id,rm.id,rt.id ORDER BY ${mode==="checkout"?"r.departure_date,rm.number NULLS LAST":"COALESCE(r.eta,'23:59'),r.arrival_date,g.last_name"} LIMIT 500`).bind(...binds),
    db.prepare("SELECT r.id,r.number,r.floor,r.room_type_id,r.front_desk_status,r.housekeeping_status,rt.code room_type_code,rt.name room_type_name FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id AND rt.property_id=r.property_id WHERE r.property_id=pms_current_property_id() AND r.active ORDER BY r.floor,r.number"),
    db.prepare("SELECT id,code,name FROM room_types WHERE property_id=pms_current_property_id() AND active ORDER BY code"),
    db.prepare("SELECT id,code,name FROM rate_plans WHERE property_id=pms_current_property_id() AND active ORDER BY code"),
    db.prepare("SELECT DISTINCT source FROM reservations WHERE property_id=pms_current_property_id() ORDER BY source"),
  ]);
  const start=new Date(`${selectedDate}T00:00:00Z`),dates=Array.from({length:18},(_,index)=>{const day=new Date(start);day.setUTCDate(day.getUTCDate()+index);return day.toISOString().slice(0,10);});
  return {mode,businessDate,selectedDate,dates,reservations:reservations.results,rooms:rooms.results,roomTypes:types.results,ratePlans:plans.results,sources:sources.results.map(row=>String(row.source))};
}

/** Loads one calendar month plus every venue master needed by the editor. */
export async function loadBanquetCalendar(db:PmsDatabase,params:URLSearchParams){
  const property=await db.prepare("SELECT business_date FROM properties WHERE id=pms_current_property_id()").first<{business_date:string}>();
  const fallback=String(property?.business_date||new Date().toISOString().slice(0,10)).slice(0,7),month=/^\d{4}-\d{2}$/u.test(params.get("month")||"")?String(params.get("month")):fallback;
  const q=bounded(params.get("q"),120).toLocaleLowerCase("ko-KR"),venueId=bounded(params.get("venueId"),80),status=bounded(params.get("status"),20).toUpperCase();
  const where=["b.property_id=pms_current_property_id()","b.event_date>=?::date","b.event_date<?::date+INTERVAL '1 month'"],binds:unknown[]=[`${month}-01`,`${month}-01`];
  if(q){const digits=phoneDigits(q);where.push("(LOWER(CONCAT_WS(' ',b.event_name,b.contact_name,b.contact_phone,v.name)) LIKE ? ESCAPE '\\' OR (?<>'' AND REGEXP_REPLACE(COALESCE(b.contact_phone,''),'\\D','','g') LIKE ? ESCAPE '\\'))");binds.push(sqlLikePattern(q),digits,sqlPhonePattern(q));}
  if(venueId){where.push("b.venue_id=?");binds.push(venueId);}
  if(["TENTATIVE","CONFIRMED","COMPLETED","CANCELLED"].includes(status)){where.push("b.status=?");binds.push(status);}
  const [venues,reservations]=await db.batch([
    db.prepare("SELECT id,code,name,capacity,location,amenities,active,version FROM banquet_venues WHERE property_id=pms_current_property_id() ORDER BY active DESC,code"),
    db.prepare(`SELECT b.*,v.code venue_code,v.name venue_name,v.capacity venue_capacity FROM banquet_reservations b JOIN banquet_venues v ON v.id=b.venue_id AND v.property_id=b.property_id WHERE ${where.join(" AND ")} ORDER BY b.event_date,b.start_time,v.code`).bind(...binds),
  ]);
  return {month,venues:venues.results,reservations:reservations.results};
}

function maskedMember(row:Record<string,unknown>){return {...row,name:`${String(row.name||"").slice(0,1)}**`,phone:"***-****-****",email:row.email?"masked@support.invalid":null,login_id:row.login_id?"masked-user":null,company:row.company?"마스킹됨":""};}

/** Server-side member filtering avoids exposing an unbounded PII directory. */
export async function loadHotelMembers(db:PmsDatabase,params:URLSearchParams,principal:Principal){
  const q=bounded(params.get("q"),120).toLocaleLowerCase("ko-KR"),type=bounded(params.get("type"),20).toUpperCase(),grade=bounded(params.get("grade"),40),adminType=bounded(params.get("administratorType"),20).toUpperCase(),active=params.get("active")||"ALL",joinedFrom=params.get("joinedFrom")||"",joinedTo=params.get("joinedTo")||"";
  const where=["property_id=pms_current_property_id()"],binds:unknown[]=[];
  if(q){const digits=phoneDigits(q);where.push("(LOWER(CONCAT_WS(' ',member_no,COALESCE(login_id,''),name,phone,COALESCE(email,''),company,grade)) LIKE ? ESCAPE '\\' OR (?<>'' AND REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g') LIKE ? ESCAPE '\\'))");binds.push(sqlLikePattern(q),digits,sqlPhonePattern(q));}
  if(["HOTEL","WEBSITE","BOTH"].includes(type)){where.push("member_type=?");binds.push(type);}
  if(grade){where.push("grade=?");binds.push(grade);}
  if(["NONE","COMPANY","WEBSITE"].includes(adminType)){where.push("administrator_type=?");binds.push(adminType);}
  if(active==="ACTIVE")where.push("active");if(active==="INACTIVE")where.push("NOT active");
  if(ISO_DATE.test(joinedFrom)){where.push("joined_date>=?");binds.push(joinedFrom);}if(ISO_DATE.test(joinedTo)){where.push("joined_date<=?");binds.push(joinedTo);}
  const rows=await db.prepare(`SELECT id,member_no,login_id,website_user_id,member_type,name,phone,email,company,grade,administrator_type,active,joined_date,last_login_at,version,created_at,updated_at,updated_by,(password_hash IS NOT NULL) password_ready FROM hotel_members WHERE ${where.join(" AND ")} ORDER BY active DESC,joined_date DESC,name LIMIT 500`).bind(...binds).all<Record<string,unknown>>();
  const members=principal.principalType==="SUPPORT"&&principal.piiMode==="MASKED"?rows.results.map(maskedMember):rows.results;
  return {members,filters:{types:["HOTEL","WEBSITE","BOTH"],administratorTypes:["NONE","COMPANY","WEBSITE"]}};
}

function passwordHash(value:unknown){
  const password=String(value||"");
  const groups=[/[a-z]/u,/[A-Z]/u,/\d/u,/[^A-Za-z0-9]/u].filter(pattern=>pattern.test(password)).length;
  if(password.length<12||password.length>128||groups<3)throw new FinalOperationsError(400,"비밀번호는 12자 이상이며 영문 대·소문자, 숫자, 특수문자 중 3종 이상을 포함해야 합니다.");
  const salt=randomBytes(16),hash=scryptSync(password,salt,64,{N:16_384,r:8,p:1});
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Mutations always write the audit event and idempotency receipt atomically. */
export async function handleFinalOperationsAction(db:PmsDatabase,body:Record<string,unknown>,principal:Principal,now:string,idempotencyKey:string){
  const action=String(body.action||""),actor=principal.email;
  if(action==="upsert_banquet_venue"){
    const code=requiredText(body.code,1,24,"연회장 코드").toUpperCase(),name=requiredText(body.name,1,120,"연회장명"),capacity=integer(body.capacity,1,10_000,"수용 인원"),location=String(body.location||"").trim().slice(0,180),amenities=String(body.amenities||"").split(",").map(item=>item.trim()).filter(Boolean).slice(0,30),active=body.active===undefined?true:bool(body.active),id=String(body.venueId||crypto.randomUUID());
    const current=body.venueId?await db.prepare("SELECT * FROM banquet_venues WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>():null;
    if(body.venueId&&!current)throw new FinalOperationsError(404,"연회장을 찾지 못했습니다.");
    if(current&&expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 연회장 정보를 먼저 변경했습니다.");
    const write=current?db.prepare("UPDATE banquet_venues SET code=?,name=?,capacity=?,location=?,amenities=?,active=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(code,name,capacity,location,amenities,active,now,actor,id,current.version):db.prepare("INSERT INTO banquet_venues(id,property_id,code,name,capacity,location,amenities,active,version,created_at,updated_at,updated_by) VALUES (?,pms_current_property_id(),?,?,?,?,?, ?,1,?,?,?)").bind(id,code,name,capacity,location,amenities,active,now,now,actor);
    await db.batch([write,db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,?, 'banquet_venue',?,?,?,?)").bind(crypto.randomUUID(),actor,current?"UPDATE_BANQUET_VENUE":"CREATE_BANQUET_VENUE",id,current,{code,name,capacity,location,amenities,active},now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  if(action==="upsert_banquet_reservation"){
    const id=String(body.banquetReservationId||crypto.randomUUID()),venueId=requiredText(body.venueId,1,120,"연회장"),eventDate=String(body.eventDate||""),startTime=String(body.startTime||""),endTime=String(body.endTime||"");
    if(!ISO_DATE.test(eventDate)||!CLOCK_TIME.test(startTime)||!CLOCK_TIME.test(endTime)||endTime<=startTime)throw new FinalOperationsError(400,"행사 날짜와 시작·종료 시각을 확인해 주세요.");
    const venue=await db.prepare("SELECT id,capacity FROM banquet_venues WHERE id=? AND property_id=pms_current_property_id() AND active").bind(venueId).first<{id:string;capacity:number}>();if(!venue)throw new FinalOperationsError(400,"활성 연회장을 선택해 주세요.");
    const eventName=requiredText(body.eventName,1,160,"행사명"),contactName=requiredText(body.contactName,1,100,"담당자"),contactPhone=String(body.contactPhone||"").trim().slice(0,32),contactEmail=String(body.contactEmail||"").trim().toLowerCase()||null,attendees=integer(body.attendees,1,10_000,"예상 인원"),fee=money(body.fee||0,"행사"),status=["TENTATIVE","CONFIRMED","COMPLETED","CANCELLED"].includes(String(body.status))?String(body.status):"TENTATIVE",notes=String(body.notes||"").trim().slice(0,2000);
    if(attendees>Number(venue.capacity))throw new FinalOperationsError(409,`선택한 연회장의 수용 인원(${venue.capacity}명)을 초과합니다.`);
    const current=body.banquetReservationId?await db.prepare("SELECT * FROM banquet_reservations WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>():null;
    if(body.banquetReservationId&&!current)throw new FinalOperationsError(404,"연회 예약을 찾지 못했습니다.");if(current&&expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 연회 예약을 먼저 변경했습니다.");
    const write=current?db.prepare("UPDATE banquet_reservations SET venue_id=?,event_date=?,start_time=?,end_time=?,event_name=?,contact_name=?,contact_phone=?,contact_email=?,attendees=?,fee=?,status=?,notes=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(venueId,eventDate,startTime,endTime,eventName,contactName,contactPhone,contactEmail,attendees,fee,status,notes,now,actor,id,current.version):db.prepare("INSERT INTO banquet_reservations(id,property_id,venue_id,event_date,start_time,end_time,event_name,contact_name,contact_phone,contact_email,attendees,fee,status,notes,version,created_at,updated_at,updated_by) VALUES (?,pms_current_property_id(),?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)").bind(id,venueId,eventDate,startTime,endTime,eventName,contactName,contactPhone,contactEmail,attendees,fee,status,notes,now,now,actor);
    await db.batch([write,db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,?, 'banquet_reservation',?,?,?,?)").bind(crypto.randomUUID(),actor,current?"UPDATE_BANQUET_RESERVATION":"CREATE_BANQUET_RESERVATION",id,current,{venueId,eventDate,startTime,endTime,eventName,contactName,attendees,fee,status},now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  if(action==="set_banquet_reservation_status"){
    const id=String(body.banquetReservationId||""),status=String(body.status||"");if(!["TENTATIVE","CONFIRMED","COMPLETED","CANCELLED"].includes(status))throw new FinalOperationsError(400,"연회 예약 상태를 확인해 주세요.");
    const current=await db.prepare("SELECT * FROM banquet_reservations WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>();if(!current)throw new FinalOperationsError(404,"연회 예약을 찾지 못했습니다.");if(expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 연회 예약 상태를 먼저 변경했습니다.");
    await db.batch([db.prepare("UPDATE banquet_reservations SET status=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(status,now,actor,id,current.version),db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'SET_BANQUET_RESERVATION_STATUS','banquet_reservation',?,?,?,?)").bind(crypto.randomUUID(),actor,id,{status:current.status},{status},now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  if(action==="upsert_hotel_member"){
    const id=String(body.memberId||crypto.randomUUID()),memberNo=requiredText(body.memberNo,1,40,"회원 코드").toUpperCase(),loginId=String(body.loginId||"").trim().toLowerCase()||null,memberType=["HOTEL","WEBSITE","BOTH"].includes(String(body.memberType))?String(body.memberType):"HOTEL",name=requiredText(body.name,1,100,"회원명"),phone=String(body.phone||"").trim().slice(0,32),email=String(body.email||"").trim().toLowerCase()||null,company=String(body.company||"").trim().slice(0,160),grade=requiredText(body.grade||"GENERAL",1,40,"등급").toUpperCase(),administratorType=["NONE","COMPANY","WEBSITE"].includes(String(body.administratorType))?String(body.administratorType):"NONE",active=body.active===undefined?true:bool(body.active),joinedDate=String(body.joinedDate||"");
    if(loginId&&loginId.length<4)throw new FinalOperationsError(400,"로그인 ID는 4자 이상 입력해 주세요.");if(!ISO_DATE.test(joinedDate))throw new FinalOperationsError(400,"가입일을 확인해 주세요.");if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))throw new FinalOperationsError(400,"이메일 형식을 확인해 주세요.");
    const current=body.memberId?await db.prepare("SELECT * FROM hotel_members WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>():null;if(body.memberId&&!current)throw new FinalOperationsError(404,"회원을 찾지 못했습니다.");if(current&&expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 회원 정보를 먼저 변경했습니다.");
    const initialHash=!current&&body.password?passwordHash(body.password):null;
    const write=current?db.prepare("UPDATE hotel_members SET member_no=?,login_id=?,member_type=?,name=?,phone=?,email=?,company=?,grade=?,administrator_type=?,active=?,joined_date=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(memberNo,loginId,memberType,name,phone,email,company,grade,administratorType,active,joinedDate,now,actor,id,current.version):db.prepare("INSERT INTO hotel_members(id,property_id,member_no,login_id,member_type,name,phone,email,company,grade,administrator_type,active,joined_date,password_hash,privacy,version,created_at,updated_at,updated_by) VALUES (?,pms_current_property_id(),?,?,?,?,?,?,?,?,?,?,?,?,'{}'::jsonb,1,?,?,?)").bind(id,memberNo,loginId,memberType,name,phone,email,company,grade,administratorType,active,joinedDate,initialHash,now,now,actor);
    const safe={memberNo,loginId,memberType,name,phone,email,company,grade,administratorType,active,joinedDate,passwordReady:Boolean(initialHash||current?.password_hash)};
    await db.batch([write,db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,?, 'hotel_member',?,?,?,?)").bind(crypto.randomUUID(),actor,current?"UPDATE_HOTEL_MEMBER":"CREATE_HOTEL_MEMBER",id,current?{...current,password_hash:current.password_hash?"[REDACTED]":null}:null,safe,now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  if(action==="set_hotel_member_active"){
    const id=String(body.memberId||""),current=await db.prepare("SELECT id,active,version FROM hotel_members WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>();if(!current)throw new FinalOperationsError(404,"회원을 찾지 못했습니다.");if(expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 회원 상태를 먼저 변경했습니다.");const active=bool(body.active);
    await db.batch([db.prepare("UPDATE hotel_members SET active=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(active,now,actor,id,current.version),db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'SET_HOTEL_MEMBER_ACTIVE','hotel_member',?,?,?,?)").bind(crypto.randomUUID(),actor,id,{active:current.active},{active},now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  if(action==="reset_hotel_member_password"){
    const id=String(body.memberId||""),current=await db.prepare("SELECT id,version FROM hotel_members WHERE id=? AND property_id=pms_current_property_id()").bind(id).first<Record<string,unknown>>();if(!current)throw new FinalOperationsError(404,"회원을 찾지 못했습니다.");if(expectedVersion(body.expectedVersion)!==Number(current.version))throw new FinalOperationsError(409,"다른 관리자가 회원 정보를 먼저 변경했습니다.");const hash=passwordHash(body.password);
    await db.batch([db.prepare("UPDATE hotel_members SET password_hash=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND property_id=pms_current_property_id() AND version=?").bind(hash,now,actor,id,current.version),db.prepare("INSERT INTO audit_logs VALUES (?,pms_current_property_id(),?,'RESET_HOTEL_MEMBER_PASSWORD','hotel_member',?,NULL,?,?)").bind(crypto.randomUUID(),actor,id,{passwordReset:true},now),idempotency(db,idempotencyKey,action,actor,now)]);return true;
  }
  return false;
}
