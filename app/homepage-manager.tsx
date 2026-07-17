"use client";

/** PMS website CMS for hotel copy, room merchandising and managed media. */
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ListSearch } from "./list-search";
import { usePmsActions } from "./pms-action-context";
import { safeStringArray } from "../lib/format";

type Settings = Record<string, string | number | boolean> & { version:number;published:boolean };
type WebsiteRoom = {
  id:string;code:string;name:string;base_rate:number;capacity:number;description:string;active:boolean;
  published:boolean|null;display_order:number|null;marketing_name:string|null;short_description:string|null;
  long_description:string|null;amenities_json:unknown;website_version:number|null;
};
type Media = { id:string;scope:"HOTEL"|"ROOM_TYPE";room_type_id:string|null;role:"HERO"|"GALLERY"|"CARD";public_url:string;alt_text:string;sort_order:number };
type WebsiteAdmin = { settings:Settings|null;rooms:WebsiteRoom[];media:Media[] };

const fieldMap = [
  ["hotelName","hotel_name","호텔명","text"],["brandEyebrow","brand_eyebrow","브랜드 아이브로우","text"],
  ["heroTitle","hero_title","메인 제목","text"],["heroSubtitle","hero_subtitle","메인 설명","textarea"],
  ["overviewTitle","overview_title","객실 섹션 제목","text"],["overviewBody","overview_body","객실 섹션 설명","textarea"],
  ["experienceTitle","experience_title","경험 섹션 제목","text"],["experienceBody","experience_body","경험 섹션 설명","textarea"],
  ["locationTitle","location_title","위치 섹션 제목","text"],["locationBody","location_body","위치 섹션 설명","textarea"],
  ["address","address","주소","text"],["phone","phone","대표 전화","text"],["email","email","문의 이메일","email"],
] as const;

function fileDataUrl(file: File) {
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("이미지를 읽지 못했습니다."));reader.readAsDataURL(file);
  });
}

const parsedAmenities = (value:unknown) => safeStringArray(value).join(", ");

export default function HomepageManager({canAdmin}:{canAdmin:boolean}) {
  const {busy,act}=usePmsActions();
  const [data,setData]=useState<WebsiteAdmin|null>(null);
  const [error,setError]=useState("");
  const [tab,setTab]=useState<"hotel"|"rooms"|"media">("hotel");
  const [selectedRoomId,setSelectedRoomId]=useState("");
  const [createOpen,setCreateOpen]=useState(false);
  const [roomQuery,setRoomQuery]=useState("");
  const load=useCallback(async()=>{try{const response=await fetch("/api/pms?view=website",{cache:"no-store"});const payload=await response.json() as WebsiteAdmin&{error?:string};if(!response.ok)throw new Error(payload.error||"홈페이지 데이터를 불러오지 못했습니다.");setData(payload);setSelectedRoomId(current=>current||payload.rooms[0]?.id||"");setError("");}catch(reason){setError(reason instanceof Error?reason.message:"홈페이지 데이터를 불러오지 못했습니다.");}},[]);
  // CMS data is intentionally fetched only when this module is opened.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void load();},[load]);
  const visibleRooms=useMemo(()=>{const keyword=roomQuery.trim().toLocaleLowerCase("ko-KR");return data?.rooms.filter(room=>!keyword||`${room.code} ${room.name} ${room.marketing_name||""} ${room.published?"홈페이지 노출":"비노출"}`.toLocaleLowerCase("ko-KR").includes(keyword))||[];},[data,roomQuery]);
  const selectedRoom=useMemo(()=>visibleRooms.find(room=>room.id===selectedRoomId)||visibleRooms[0]||null,[visibleRooms,selectedRoomId]);

  async function saveSettings(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!data?.settings)return;const form=new FormData(event.currentTarget),payload:Record<string,string>={version:String(data.settings.version),published:String(form.get("published")==="on")};for(const [name] of fieldMap)payload[name]=String(form.get(name)||"");payload.checkinTime=String(form.get("checkinTime")||"");payload.checkoutTime=String(form.get("checkoutTime")||"");if(await act("update_website_settings",payload))await load();}
  async function saveRoom(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!selectedRoom)return;const form=new FormData(event.currentTarget);const amenities=String(form.get("amenities")||"").split(",").map(item=>item.trim()).filter(Boolean);if(await act("update_room_type_website",{roomTypeId:selectedRoom.id,version:String(selectedRoom.website_version||0),published:String(form.get("published")==="on"),displayOrder:String(form.get("displayOrder")||"0"),marketingName:String(form.get("marketingName")||""),shortDescription:String(form.get("shortDescription")||""),longDescription:String(form.get("longDescription")||""),amenities:JSON.stringify(amenities)}))await load();}
  async function createRoomType(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);if(await act("create_room_type",{code:String(form.get("code")||""),name:String(form.get("name")||""),baseRate:String(form.get("baseRate")||""),capacity:String(form.get("capacity")||""),description:String(form.get("description")||"")})){setCreateOpen(false);await load();}}
  async function upload(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget),file=form.get("file");if(!(file instanceof File)||!file.size){setError("업로드할 이미지를 선택하세요.");return;}if(file.size>3*1024*1024){setError("이미지는 3MB 이하만 업로드할 수 있습니다.");return;}try{const scope=String(form.get("scope")) as "HOTEL"|"ROOM_TYPE";const ok=await act("upload_website_media",{scope,roomTypeId:scope==="ROOM_TYPE"?String(form.get("roomTypeId")||""):"",role:String(form.get("role")||"GALLERY"),altText:String(form.get("altText")||""),sortOrder:String(form.get("sortOrder")||"0"),filename:file.name,dataUrl:await fileDataUrl(file)});if(ok){event.currentTarget.reset();await load();}}catch(reason){setError(reason instanceof Error?reason.message:"이미지를 업로드하지 못했습니다.");}}

  if(!data)return <section className="panel full website-loading"><p>{error||"홈페이지 관리 데이터를 준비하고 있습니다."}</p><button type="button" onClick={()=>void load()}>다시 시도</button></section>;
  return <section className="website-manager">
    <div className="website-hero-panel"><div><p className="eyebrow">AURORA WEBSITE STUDIO</p><h2>호텔 홈페이지 관리</h2><span>저장한 소개·객실·이미지는 공식 홈페이지와 예약 엔진에 실시간 반영됩니다.</span></div><a className="primary" href="/hotel" target="_blank" rel="noreferrer">홈페이지 미리보기 ↗</a></div>
    <div className="website-tabs" role="tablist" aria-label="홈페이지 관리 메뉴">{[["hotel","호텔 소개"],["rooms","객실 콘텐츠"],["media","이미지 라이브러리"]].map(([id,label])=><button type="button" role="tab" aria-selected={tab===id} className={tab===id?"on":""} key={id} onClick={()=>setTab(id as typeof tab)}>{label}</button>)}</div>
    {error&&<p className="website-error" role="alert">{error}</p>}

    {tab==="hotel"&&data.settings&&<form className="panel website-form" key={String(data.settings.version)} onSubmit={saveSettings}><div className="panel-title"><div><h3>호텔 소개와 기본 정보</h3><p>브랜드 메시지와 각 홈페이지 섹션의 텍스트를 관리합니다.</p></div><label className="website-publish"><span>홈페이지 공개</span><input name="published" type="checkbox" defaultChecked={Boolean(data.settings.published)} disabled={!canAdmin}/></label></div><div className="website-field-grid">{fieldMap.map(([name,column,label,type])=><label className={type==="textarea"?"wide":""} key={name}><span>{label}</span>{type==="textarea"?<textarea name={name} defaultValue={String(data.settings?.[column]||"")} required maxLength={500}/>:<input name={name} type={type} defaultValue={String(data.settings?.[column]||"")} required/>}</label>)}<label><span>체크인</span><input name="checkinTime" type="time" defaultValue={String(data.settings.checkin_time||"15:00")} required/></label><label><span>체크아웃</span><input name="checkoutTime" type="time" defaultValue={String(data.settings.checkout_time||"11:00")} required/></label></div><div className="website-save"><span>버전 {data.settings.version} · 충돌 방지 저장</span><button className="primary" type="submit" disabled={!canAdmin||Boolean(busy)}>호텔 소개 저장</button></div></form>}

    {tab==="rooms"&&<div className="website-room-layout"><aside className="panel website-room-list"><div className="panel-title"><div><h3>객실 타입</h3><p>{data.rooms.length}개 마스터</p></div>{canAdmin&&<button type="button" className="soft-button" onClick={()=>setCreateOpen(value=>!value)}>＋ 타입 생성</button>}</div><ListSearch value={roomQuery} onChange={setRoomQuery} label="홈페이지 객실 검색" placeholder="코드·객실명·노출 상태" count={visibleRooms.length}/>{createOpen&&<form className="website-create-form" onSubmit={createRoomType}><input name="code" placeholder="코드 (예: FAM)" required/><input name="name" placeholder="객실 타입명" required/><div><input name="baseRate" type="number" min="0" placeholder="기준가" required/><input name="capacity" type="number" min="1" max="20" placeholder="인원" required/></div><textarea name="description" placeholder="기본 설명" required/><button type="submit" disabled={Boolean(busy)}>생성</button></form>}{visibleRooms.map(room=><button type="button" className={selectedRoomId===room.id?"on":""} key={room.id} onClick={()=>setSelectedRoomId(room.id)}><span><b>{room.code} · {room.name}</b><small>{room.published?"홈페이지 노출":"비노출"} · 최대 {room.capacity}인</small></span><i>›</i></button>)}{visibleRooms.length===0&&<div className="empty-state"><b>검색 결과가 없습니다</b><p>객실 코드나 이름을 다시 확인해 주세요.</p></div>}</aside>{selectedRoom&&<form className="panel website-room-form" key={`${selectedRoom.id}:${selectedRoom.website_version}`} onSubmit={saveRoom}><div className="panel-title"><div><p className="eyebrow">{selectedRoom.code}</p><h3>{selectedRoom.name} 홈페이지 콘텐츠</h3></div><label className="website-publish"><span>객실 공개</span><input name="published" type="checkbox" defaultChecked={Boolean(selectedRoom.published)} disabled={!canAdmin}/></label></div><div className="website-field-grid"><label><span>홈페이지 객실명</span><input name="marketingName" defaultValue={selectedRoom.marketing_name||selectedRoom.name} required/></label><label><span>노출 순서</span><input name="displayOrder" type="number" min="0" defaultValue={selectedRoom.display_order??0} required/></label><label className="wide"><span>짧은 객실 소개</span><textarea name="shortDescription" defaultValue={selectedRoom.short_description||selectedRoom.description} maxLength={300} required/></label><label className="wide"><span>상세 객실 소개</span><textarea name="longDescription" defaultValue={selectedRoom.long_description||selectedRoom.description} maxLength={2000} required/></label><label className="wide"><span>편의시설 (쉼표로 구분)</span><input name="amenities" defaultValue={parsedAmenities(selectedRoom.amenities_json)} placeholder="무료 Wi-Fi, 스마트 TV, 프리미엄 침구"/></label></div><div className="website-sync-note"><b>실시간 판매 연동</b><span>기준가 {Number(selectedRoom.base_rate).toLocaleString()}원 · 실제 노출가는 재고 & 요금 캘린더의 일자별 호텔 판매가를 사용합니다.</span></div><div className="website-save"><span>콘텐츠 버전 {selectedRoom.website_version||"신규"}</span><button className="primary" type="submit" disabled={!canAdmin||Boolean(busy)}>객실 콘텐츠 저장</button></div></form>}</div>}

    {tab==="media"&&<div className="website-media-layout"><form className="panel website-upload" onSubmit={upload}><div className="panel-title"><div><h3>새 이미지 업로드</h3><p>JPEG·PNG·WebP, 파일당 최대 3MB</p></div></div><label><span>연결 위치</span><select name="scope" defaultValue="HOTEL" onChange={(event)=>{const target=event.currentTarget.form?.elements.namedItem("roomTypeId") as HTMLSelectElement|null;if(target)target.disabled=event.target.value!=="ROOM_TYPE"}}><option value="HOTEL">호텔 공통</option><option value="ROOM_TYPE">객실 타입</option></select></label><label><span>객실 타입</span><select name="roomTypeId" disabled>{data.rooms.map(room=><option value={room.id} key={room.id}>{room.code} · {room.name}</option>)}</select></label><label><span>이미지 역할</span><select name="role" defaultValue="GALLERY"><option value="HERO">메인 히어로</option><option value="CARD">객실 대표</option><option value="GALLERY">갤러리</option></select></label><label><span>대체 설명</span><input name="altText" placeholder="예: 야경이 보이는 디럭스 킹 객실" required maxLength={180}/></label><label><span>정렬 순서</span><input name="sortOrder" type="number" min="0" defaultValue="0"/></label><label className="website-file"><span>이미지 파일</span><input name="file" type="file" accept="image/jpeg,image/png,image/webp" required/></label><button className="primary" type="submit" disabled={!canAdmin||Boolean(busy)}>이미지 업로드</button></form><section className="panel website-media-library"><div className="panel-title"><div><h3>이미지 라이브러리</h3><p>{data.media.length}개 이미지 · 공개 홈페이지 연결 상태</p></div></div><div className="website-media-grid">{data.media.map(item=><article key={item.id}><div style={{backgroundImage:`url(${JSON.stringify(item.public_url)})`}} role="img" aria-label={item.alt_text}/><p><b>{item.role}</b><span>{item.scope==="HOTEL"?"호텔":data.rooms.find(room=>room.id===item.room_type_id)?.code||"객실"}</span></p><small>{item.alt_text}</small>{canAdmin&&<button type="button" disabled={Boolean(busy)} onClick={async()=>{if(window.confirm("이 이미지를 홈페이지와 Storage에서 삭제할까요?")&&await act("delete_website_media",{mediaId:item.id}))await load();}}>삭제</button>}</article>)}{!data.media.length&&<div className="empty-state"><b>등록된 이미지가 없습니다</b><p>기본 Aurora 아트가 표시됩니다. 호텔 또는 객실 이미지를 업로드해 보세요.</p></div>}</div></section></div>}
  </section>;
}
