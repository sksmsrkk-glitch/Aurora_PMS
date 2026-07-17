"use client";

/** Visual PMS website studio for hotel content, navigation, rooms and managed media. */
import { FormEvent, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { safeStringArray } from "../lib/format";
import {
  normalizeWebsiteNavigation,
  type WebsiteHeroLayout,
  type WebsiteNavigationItem,
} from "./website-editor-contract";
import { ListSearch } from "./list-search";
import { usePmsActions } from "./pms-action-context";

type Settings = Record<string, unknown> & { version: number; published: boolean };
type WebsiteRoom = {
  id:string;code:string;name:string;base_rate:number;capacity:number;description:string;active:boolean;
  published:boolean|null;display_order:number|null;marketing_name:string|null;short_description:string|null;
  long_description:string|null;amenities_json:unknown;website_version:number|null;
};
type Media = { id:string;scope:"HOTEL"|"ROOM_TYPE";room_type_id:string|null;role:"HERO"|"GALLERY"|"CARD";public_url:string;alt_text:string;sort_order:number };
type WebsiteAdmin = { settings:Settings|null;rooms:WebsiteRoom[];media:Media[] };

type EditorDraft = {
  hotelName:string;brandEyebrow:string;heroTitle:string;heroSubtitle:string;
  overviewTitle:string;overviewBody:string;experienceTitle:string;experienceBody:string;
  locationTitle:string;locationBody:string;address:string;phone:string;email:string;
  checkinTime:string;checkoutTime:string;published:boolean;heroMediaId:string;
  heroLayout:WebsiteHeroLayout;heroOverlay:number;heroHeight:number;heroCtaLabel:string;
  heroCtaHref:string;bookingCtaLabel:string;themeAccent:string;navigation:WebsiteNavigationItem[];
};

const contentFields = [
  ["hotelName","호텔명","text"],["brandEyebrow","브랜드 아이브로우","text"],
  ["heroTitle","메인 제목","text"],["heroSubtitle","메인 설명","textarea"],
  ["overviewTitle","객실 섹션 제목","text"],["overviewBody","객실 섹션 설명","textarea"],
  ["experienceTitle","경험 섹션 제목","text"],["experienceBody","경험 섹션 설명","textarea"],
  ["locationTitle","위치 섹션 제목","text"],["locationBody","위치 섹션 설명","textarea"],
  ["address","주소","text"],["phone","대표 전화","text"],["email","문의 이메일","email"],
] as const satisfies ReadonlyArray<readonly [keyof EditorDraft,string,"text"|"textarea"|"email"]>;

const stringSetting = (settings:Settings, key:string, fallback="") => String(settings[key] ?? fallback);
const parsedAmenities = (value:unknown) => safeStringArray(value).join(", ");

function draftFromSettings(settings:Settings):EditorDraft {
  return {
    hotelName:stringSetting(settings,"hotel_name"),brandEyebrow:stringSetting(settings,"brand_eyebrow"),
    heroTitle:stringSetting(settings,"hero_title"),heroSubtitle:stringSetting(settings,"hero_subtitle"),
    overviewTitle:stringSetting(settings,"overview_title"),overviewBody:stringSetting(settings,"overview_body"),
    experienceTitle:stringSetting(settings,"experience_title"),experienceBody:stringSetting(settings,"experience_body"),
    locationTitle:stringSetting(settings,"location_title"),locationBody:stringSetting(settings,"location_body"),
    address:stringSetting(settings,"address"),phone:stringSetting(settings,"phone"),email:stringSetting(settings,"email"),
    checkinTime:stringSetting(settings,"checkin_time","15:00").slice(0,5),checkoutTime:stringSetting(settings,"checkout_time","11:00").slice(0,5),
    published:Boolean(settings.published),heroMediaId:stringSetting(settings,"hero_media_id"),
    heroLayout:settings.hero_layout === "CENTER" || settings.hero_layout === "SPLIT" ? settings.hero_layout : "LEFT",
    heroOverlay:Number(settings.hero_overlay ?? 60),heroHeight:Number(settings.hero_height ?? 720),
    heroCtaLabel:stringSetting(settings,"hero_cta_label","객실 둘러보기"),heroCtaHref:stringSetting(settings,"hero_cta_href","#stay"),
    bookingCtaLabel:stringSetting(settings,"booking_cta_label","예약하기"),themeAccent:stringSetting(settings,"theme_accent","#2764E7"),
    navigation:normalizeWebsiteNavigation(settings.navigation_json),
  };
}

function fileDataUrl(file:File) {
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result));
    reader.onerror=()=>reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function validateImage(file:File) {
  if(!file.size)throw new Error("업로드할 이미지를 선택하세요.");
  if(file.size>3*1024*1024)throw new Error("이미지는 3MB 이하만 업로드할 수 있습니다.");
  if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw new Error("JPEG, PNG 또는 WebP 이미지만 사용할 수 있습니다.");
}

export default function HomepageManager({canAdmin}:{canAdmin:boolean}) {
  const {busy,act}=usePmsActions();
  const [data,setData]=useState<WebsiteAdmin|null>(null);
  const [draft,setDraft]=useState<EditorDraft|null>(null);
  const [error,setError]=useState("");
  const [tab,setTab]=useState<"editor"|"rooms"|"media">("editor");
  const [previewDevice,setPreviewDevice]=useState<"desktop"|"mobile">("desktop");
  const [selectedRoomId,setSelectedRoomId]=useState("");
  const [createOpen,setCreateOpen]=useState(false);
  const [roomQuery,setRoomQuery]=useState("");

  const load=useCallback(async()=>{
    try {
      const response=await fetch("/api/pms?view=website",{cache:"no-store"});
      const payload=await response.json() as WebsiteAdmin&{error?:string};
      if(!response.ok)throw new Error(payload.error||"홈페이지 데이터를 불러오지 못했습니다.");
      setData(payload);setDraft(payload.settings?draftFromSettings(payload.settings):null);
      setSelectedRoomId(current=>current||payload.rooms[0]?.id||"");setError("");
    } catch(reason) { setError(reason instanceof Error?reason.message:"홈페이지 데이터를 불러오지 못했습니다."); }
  },[]);

  // CMS data is intentionally fetched only when this module is opened.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void load();},[load]);

  const visibleRooms=useMemo(()=>{
    const keyword=roomQuery.trim().toLocaleLowerCase("ko-KR");
    return data?.rooms.filter(room=>!keyword||`${room.code} ${room.name} ${room.marketing_name||""} ${room.published?"홈페이지 노출":"비노출"}`.toLocaleLowerCase("ko-KR").includes(keyword))||[];
  },[data,roomQuery]);
  const selectedRoom=useMemo(()=>visibleRooms.find(room=>room.id===selectedRoomId)||visibleRooms[0]||null,[visibleRooms,selectedRoomId]);
  const hotelMedia=useMemo(()=>data?.media.filter(item=>item.scope==="HOTEL")||[],[data]);
  const selectedHero=hotelMedia.find(item=>item.id===draft?.heroMediaId)||hotelMedia.find(item=>item.role==="HERO")||hotelMedia[0];
  const enabledNavigationCount=draft?.navigation.filter(item=>item.enabled).length||0;

  function updateDraft<K extends keyof EditorDraft>(key:K,value:EditorDraft[K]) { setDraft(current=>current?{...current,[key]:value}:current); }

  function editorPayload(next:EditorDraft) {
    if(!data?.settings)throw new Error("홈페이지 설정이 준비되지 않았습니다.");
    return {
      version:String(data.settings.version),published:String(next.published),hotelName:next.hotelName,brandEyebrow:next.brandEyebrow,
      heroTitle:next.heroTitle,heroSubtitle:next.heroSubtitle,overviewTitle:next.overviewTitle,overviewBody:next.overviewBody,
      experienceTitle:next.experienceTitle,experienceBody:next.experienceBody,locationTitle:next.locationTitle,locationBody:next.locationBody,
      address:next.address,phone:next.phone,email:next.email,checkinTime:next.checkinTime,checkoutTime:next.checkoutTime,
      heroMediaId:next.heroMediaId,heroLayout:next.heroLayout,heroOverlay:String(next.heroOverlay),heroHeight:String(next.heroHeight),
      heroCtaLabel:next.heroCtaLabel,heroCtaHref:next.heroCtaHref,bookingCtaLabel:next.bookingCtaLabel,
      themeAccent:next.themeAccent,navigationJson:JSON.stringify(next.navigation),
    };
  }

  async function saveEditor() {
    if(!draft)return;
    try { if(await act("update_website_settings",editorPayload(draft)))await load(); }
    catch(reason){setError(reason instanceof Error?reason.message:"홈페이지 설정을 저장하지 못했습니다.");}
  }

  /** Uploads and selects a hero in two idempotent commands while preserving optimistic settings versioning. */
  async function uploadHero(file:File) {
    if(!draft)return;
    try {
      validateImage(file);setError("");
      const mediaId=crypto.randomUUID();
      const uploaded=await act("upload_website_media",{mediaId,scope:"HOTEL",roomTypeId:"",role:"HERO",altText:draft.heroTitle||"호텔 히어로 이미지",sortOrder:"0",filename:file.name,dataUrl:await fileDataUrl(file)});
      if(!uploaded)return;
      const next={...draft,heroMediaId:mediaId};
      if(await act("update_website_settings",editorPayload(next)))await load();
    } catch(reason){setError(reason instanceof Error?reason.message:"히어로 이미지를 업로드하지 못했습니다.");}
  }

  function moveNavigation(index:number,direction:-1|1) {
    if(!draft)return;
    const target=index+direction;if(target<0||target>=draft.navigation.length)return;
    const navigation=[...draft.navigation];[navigation[index],navigation[target]]=[navigation[target],navigation[index]];
    updateDraft("navigation",navigation);
  }

  function patchNavigation(index:number,patch:Partial<WebsiteNavigationItem>) {
    if(!draft)return;
    const selected=draft.navigation[index];
    if(patch.enabled===false&&selected.enabled&&enabledNavigationCount===1)return;
    const navigation=draft.navigation.map((item,itemIndex)=>itemIndex===index?{...item,...patch}:item);
    const nextHeroHref=patch.enabled===false&&draft.heroCtaHref===`#${selected.id}`
      ? `#${navigation.find(item=>item.enabled)?.id||"stay"}`
      : draft.heroCtaHref;
    setDraft({...draft,navigation,heroCtaHref:nextHeroHref});
  }

  async function saveRoom(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!selectedRoom)return;const form=new FormData(event.currentTarget);const amenities=String(form.get("amenities")||"").split(",").map(item=>item.trim()).filter(Boolean);if(await act("update_room_type_website",{roomTypeId:selectedRoom.id,version:String(selectedRoom.website_version||0),published:String(form.get("published")==="on"),displayOrder:String(form.get("displayOrder")||"0"),marketingName:String(form.get("marketingName")||""),shortDescription:String(form.get("shortDescription")||""),longDescription:String(form.get("longDescription")||""),amenities:JSON.stringify(amenities)}))await load();}
  async function createRoomType(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);if(await act("create_room_type",{code:String(form.get("code")||""),name:String(form.get("name")||""),baseRate:String(form.get("baseRate")||""),capacity:String(form.get("capacity")||""),description:String(form.get("description")||"")})){setCreateOpen(false);await load();}}
  async function upload(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget),file=form.get("file");if(!(file instanceof File)){setError("업로드할 이미지를 선택하세요.");return;}try{validateImage(file);const scope=String(form.get("scope")) as "HOTEL"|"ROOM_TYPE";const ok=await act("upload_website_media",{scope,roomTypeId:scope==="ROOM_TYPE"?String(form.get("roomTypeId")||""):"",role:String(form.get("role")||"GALLERY"),altText:String(form.get("altText")||""),sortOrder:String(form.get("sortOrder")||"0"),filename:file.name,dataUrl:await fileDataUrl(file)});if(ok){event.currentTarget.reset();await load();}}catch(reason){setError(reason instanceof Error?reason.message:"이미지를 업로드하지 못했습니다.");}}

  if(!data)return <section className="panel full website-loading"><p>{error||"홈페이지 관리 데이터를 준비하고 있습니다."}</p><button type="button" onClick={()=>void load()}>다시 시도</button></section>;
  return <section className="website-manager">
    <div className="website-hero-panel"><div><p className="eyebrow">AURORA WEBSITE STUDIO</p><h2>호텔 홈페이지 비주얼 에디터</h2><span>히어로·메뉴·호텔 소개·객실·이미지를 한곳에서 편집하고 공식 홈페이지에 반영합니다.</span></div><a className="primary" href="/hotel" target="_blank" rel="noreferrer">실제 홈페이지 열기 ↗</a></div>
    <div className="website-tabs" role="tablist" aria-label="홈페이지 관리 메뉴">{[["editor","비주얼 에디터"],["rooms","객실 콘텐츠"],["media","이미지 라이브러리"]].map(([id,label])=><button type="button" role="tab" aria-selected={tab===id} className={tab===id?"on":""} key={id} onClick={()=>setTab(id as typeof tab)}>{label}</button>)}</div>
    {error&&<p className="website-error" role="alert">{error}</p>}

    {tab==="editor"&&draft&&<div className="website-editor-layout">
      <section className="panel website-editor-controls">
        <div className="panel-title"><div><h3>페이지 디자인</h3><p>변경 내용은 오른쪽 미리보기에 즉시 반영되며 저장 전까지 공개되지 않습니다.</p></div><label className="website-publish"><span>홈페이지 공개</span><input type="checkbox" checked={draft.published} onChange={event=>updateDraft("published",event.target.checked)} disabled={!canAdmin}/></label></div>

        <details className="website-editor-group" open><summary><span><b>히어로</b><small>첫 화면 이미지와 메시지</small></span><i>⌄</i></summary><div className="website-editor-body">
          <label><span>브랜드 문구</span><input value={draft.brandEyebrow} onChange={event=>updateDraft("brandEyebrow",event.target.value)} maxLength={120}/></label>
          <label><span>메인 제목</span><input value={draft.heroTitle} onChange={event=>updateDraft("heroTitle",event.target.value)} maxLength={160}/></label>
          <label><span>메인 설명</span><textarea value={draft.heroSubtitle} onChange={event=>updateDraft("heroSubtitle",event.target.value)} maxLength={500}/></label>
          <div className="website-control-label"><span>히어로 이미지</span><small>라이브러리에서 선택하거나 새 이미지를 첨부하세요.</small></div>
          <div className="website-hero-picker">
            {hotelMedia.map(item=><button type="button" className={item.id===draft.heroMediaId?"on":""} key={item.id} onClick={()=>updateDraft("heroMediaId",item.id)} aria-label={`${item.alt_text} 히어로로 선택`}><i style={{backgroundImage:`url(${JSON.stringify(item.public_url)})`}}/><span>{item.alt_text}</span></button>)}
            <label className="website-hero-upload"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>{const file=event.target.files?.[0];if(file)void uploadHero(file);event.currentTarget.value="";}} disabled={!canAdmin||Boolean(busy)}/><b>＋</b><span>새 이미지 첨부</span></label>
          </div>
          <div className="website-control-label"><span>텍스트 배치</span></div>
          <div className="website-segmented">{[["LEFT","왼쪽"],["CENTER","가운데"],["SPLIT","오른쪽"]].map(([value,label])=><button type="button" className={draft.heroLayout===value?"on":""} key={value} onClick={()=>updateDraft("heroLayout",value as WebsiteHeroLayout)}>{label}</button>)}</div>
          <label className="website-range"><span>이미지 어둡기 <b>{draft.heroOverlay}%</b></span><input type="range" min="0" max="90" value={draft.heroOverlay} onChange={event=>updateDraft("heroOverlay",Number(event.target.value))}/></label>
          <label className="website-range"><span>히어로 높이 <b>{draft.heroHeight}px</b></span><input type="range" min="520" max="960" step="20" value={draft.heroHeight} onChange={event=>updateDraft("heroHeight",Number(event.target.value))}/></label>
          <div className="website-two-fields"><label><span>히어로 버튼명</span><input value={draft.heroCtaLabel} onChange={event=>updateDraft("heroCtaLabel",event.target.value)} maxLength={40}/></label><label><span>연결 위치</span><select value={draft.heroCtaHref} onChange={event=>updateDraft("heroCtaHref",event.target.value)}><option value="#stay" disabled={!draft.navigation.find(item=>item.id==="stay")?.enabled}>객실 섹션</option><option value="#experience" disabled={!draft.navigation.find(item=>item.id==="experience")?.enabled}>경험 섹션</option><option value="#location" disabled={!draft.navigation.find(item=>item.id==="location")?.enabled}>위치 섹션</option><option value="/hotel/book">예약 엔진</option></select></label></div>
        </div></details>

        <details className="website-editor-group" open><summary><span><b>메뉴와 섹션</b><small>순서·라벨·노출 설정</small></span><i>⌄</i></summary><div className="website-editor-body">
          <div className="website-navigation-list">{draft.navigation.map((item,index)=><div key={item.id}><span className="website-drag" aria-hidden="true">⋮⋮</span><input aria-label={`${item.id} 메뉴명`} value={item.label} maxLength={24} onChange={event=>patchNavigation(index,{label:event.target.value})}/><div className="website-order-buttons"><button type="button" onClick={()=>moveNavigation(index,-1)} disabled={index===0} aria-label="위로 이동">↑</button><button type="button" onClick={()=>moveNavigation(index,1)} disabled={index===draft.navigation.length-1} aria-label="아래로 이동">↓</button></div><label className="website-toggle"><input type="checkbox" checked={item.enabled} disabled={item.enabled&&enabledNavigationCount===1} onChange={event=>patchNavigation(index,{enabled:event.target.checked})}/><span/></label></div>)}</div>
          <label><span>상단 예약 버튼명</span><input value={draft.bookingCtaLabel} onChange={event=>updateDraft("bookingCtaLabel",event.target.value)} maxLength={30}/></label>
          <label className="website-color"><span>강조색</span><div><input type="color" value={draft.themeAccent} onChange={event=>updateDraft("themeAccent",event.target.value.toUpperCase())}/><input value={draft.themeAccent} pattern="#[0-9A-Fa-f]{6}" maxLength={7} onChange={event=>updateDraft("themeAccent",event.target.value.toUpperCase())}/></div></label>
        </div></details>

        <details className="website-editor-group"><summary><span><b>콘텐츠와 호텔 정보</b><small>섹션 문구·연락처·체크인 시간</small></span><i>⌄</i></summary><div className="website-editor-body website-editor-fields">
          {contentFields.filter(([key])=>!(["brandEyebrow","heroTitle","heroSubtitle"] as string[]).includes(key)).map(([key,label,type])=><label className={type==="textarea"?"wide":""} key={key}><span>{label}</span>{type==="textarea"?<textarea value={String(draft[key])} onChange={event=>updateDraft(key,event.target.value as never)} maxLength={500}/>:<input type={type} value={String(draft[key])} onChange={event=>updateDraft(key,event.target.value as never)}/>}</label>)}
          <div className="website-two-fields"><label><span>체크인</span><input type="time" value={draft.checkinTime} onChange={event=>updateDraft("checkinTime",event.target.value)}/></label><label><span>체크아웃</span><input type="time" value={draft.checkoutTime} onChange={event=>updateDraft("checkoutTime",event.target.value)}/></label></div>
        </div></details>
        <div className="website-editor-save"><span>버전 {data.settings?.version} · 저장 후 공개 페이지는 최대 60초 내 갱신</span><button className="primary" type="button" onClick={()=>void saveEditor()} disabled={!canAdmin||Boolean(busy)}>변경사항 저장</button></div>
      </section>

      <aside className="website-live-preview">
        <div className="website-preview-toolbar"><div><i/><i/><i/></div><span>aurora.hotel</span><div className="website-preview-devices"><button type="button" className={previewDevice==="desktop"?"on":""} onClick={()=>setPreviewDevice("desktop")} aria-label="데스크톱 미리보기">▱</button><button type="button" className={previewDevice==="mobile"?"on":""} onClick={()=>setPreviewDevice("mobile")} aria-label="모바일 미리보기">▯</button></div></div>
        <div className={`website-preview-canvas ${previewDevice}`} style={{"--preview-accent":draft.themeAccent} as CSSProperties}>
          <div className="website-preview-page">
            <header><b>AURORA</b><nav>{draft.navigation.filter(item=>item.enabled).map(item=><span key={item.id}>{item.label}</span>)}</nav><i>{draft.bookingCtaLabel}</i></header>
            <section className={`website-preview-hero ${draft.heroLayout.toLowerCase()}`} style={{minHeight:`${Math.round(draft.heroHeight*.45)}px`,backgroundImage:selectedHero?`linear-gradient(90deg,rgba(5,13,29,${Math.min(.94,draft.heroOverlay/100+.14)}),rgba(5,13,29,${Math.max(.08,draft.heroOverlay/250)})),url(${JSON.stringify(selectedHero.public_url)})`:undefined}}>
              <div><small>{draft.brandEyebrow}</small><h2>{draft.heroTitle||"메인 제목을 입력하세요"}</h2><p>{draft.heroSubtitle}</p><span className="website-preview-cta">{draft.heroCtaLabel} →</span></div>
            </section>
            {draft.navigation.filter(item=>item.enabled).map(item=><section className={`website-preview-section ${item.id}`} key={item.id}><small>{item.label}</small><h3>{item.id==="stay"?draft.overviewTitle:item.id==="experience"?draft.experienceTitle:draft.locationTitle}</h3><p>{item.id==="stay"?draft.overviewBody:item.id==="experience"?draft.experienceBody:draft.locationBody}</p>{item.id==="stay"&&<div><i/><i/><i/></div>}</section>)}
          </div>
        </div>
        <p><b>실시간 미리보기</b> · 실제 예약 검색과 반응형 동작은 저장 후 홈페이지에서 확인하세요.</p>
      </aside>
    </div>}

    {tab==="rooms"&&<div className="website-room-layout"><aside className="panel website-room-list"><div className="panel-title"><div><h3>객실 선택</h3><p>{data.rooms.length}개 마스터</p></div>{canAdmin&&<button type="button" className="soft-button" onClick={()=>setCreateOpen(value=>!value)}>＋ 타입 생성</button>}</div><ListSearch value={roomQuery} onChange={setRoomQuery} label="홈페이지 객실 검색" placeholder="코드·객실명·노출 상태" count={visibleRooms.length}/>{createOpen&&<form className="website-create-form" onSubmit={createRoomType}><input name="code" placeholder="코드 (예: FAM)" required/><input name="name" placeholder="객실 타입명" required/><div><input name="baseRate" type="number" min="0" placeholder="기준가" required/><input name="capacity" type="number" min="1" max="20" placeholder="인원" required/></div><textarea name="description" placeholder="기본 설명" required/><button type="submit" disabled={Boolean(busy)}>생성</button></form>}{visibleRooms.map(room=><button type="button" className={selectedRoomId===room.id?"on":""} key={room.id} onClick={()=>setSelectedRoomId(room.id)}><span><b>{room.code} · {room.name}</b><small>{room.published?"홈페이지 노출":"비노출"} · 최대 {room.capacity}명</small></span><i>→</i></button>)}{visibleRooms.length===0&&<div className="empty-state"><b>검색 결과가 없습니다</b><p>객실 코드나 이름을 다시 확인해 주세요.</p></div>}</aside>{selectedRoom&&<form className="panel website-room-form" key={`${selectedRoom.id}:${selectedRoom.website_version}`} onSubmit={saveRoom}><div className="panel-title"><div><p className="eyebrow">{selectedRoom.code}</p><h3>{selectedRoom.name} 홈페이지 콘텐츠</h3></div><label className="website-publish"><span>객실 공개</span><input name="published" type="checkbox" defaultChecked={Boolean(selectedRoom.published)} disabled={!canAdmin}/></label></div><div className="website-field-grid"><label><span>홈페이지 객실명</span><input name="marketingName" defaultValue={selectedRoom.marketing_name||selectedRoom.name} required/></label><label><span>노출 순서</span><input name="displayOrder" type="number" min="0" defaultValue={selectedRoom.display_order??0} required/></label><label className="wide"><span>짧은 객실 소개</span><textarea name="shortDescription" defaultValue={selectedRoom.short_description||selectedRoom.description} maxLength={300} required/></label><label className="wide"><span>상세 객실 소개</span><textarea name="longDescription" defaultValue={selectedRoom.long_description||selectedRoom.description} maxLength={2000} required/></label><label className="wide"><span>편의시설 (쉼표로 구분)</span><input name="amenities" defaultValue={parsedAmenities(selectedRoom.amenities_json)} placeholder="무료 Wi-Fi, 스마트 TV, 프리미엄 침구"/></label></div><div className="website-sync-note"><b>실시간 판매 연동</b><span>기준가 {Number(selectedRoom.base_rate).toLocaleString()}원 · 실제 노출가는 재고 & 요금 캘린더의 일자별 호텔 판매가를 사용합니다.</span></div><div className="website-save"><span>콘텐츠 버전 {selectedRoom.website_version||"신규"}</span><button className="primary" type="submit" disabled={!canAdmin||Boolean(busy)}>객실 콘텐츠 저장</button></div></form>}</div>}

    {tab==="media"&&<div className="website-media-layout"><form className="panel website-upload" onSubmit={upload}><div className="panel-title"><div><h3>새 이미지 업로드</h3><p>JPEG·PNG·WebP, 파일당 최대 3MB</p></div></div><label><span>연결 위치</span><select name="scope" defaultValue="HOTEL" onChange={(event)=>{const target=event.currentTarget.form?.elements.namedItem("roomTypeId") as HTMLSelectElement|null;if(target)target.disabled=event.target.value!=="ROOM_TYPE"}}><option value="HOTEL">호텔 공통</option><option value="ROOM_TYPE">객실 타입</option></select></label><label><span>객실 타입</span><select name="roomTypeId" disabled>{data.rooms.map(room=><option value={room.id} key={room.id}>{room.code} · {room.name}</option>)}</select></label><label><span>이미지 역할</span><select name="role" defaultValue="GALLERY"><option value="HERO">메인 히어로</option><option value="CARD">객실 카드</option><option value="GALLERY">갤러리</option></select></label><label><span>대체 설명</span><input name="altText" placeholder="큰 창으로 보이는 서울 야경의 객실" required maxLength={180}/></label><label><span>정렬 순서</span><input name="sortOrder" type="number" min="0" defaultValue="0"/></label><label className="website-file"><span>이미지 파일</span><input name="file" type="file" accept="image/jpeg,image/png,image/webp" required/></label><button className="primary" type="submit" disabled={!canAdmin||Boolean(busy)}>이미지 업로드</button></form><section className="panel website-media-library"><div className="panel-title"><div><h3>이미지 라이브러리</h3><p>{data.media.length}개 이미지 · 공개 홈페이지 연결 상태</p></div></div><div className="website-media-grid">{data.media.map(item=><article key={item.id}><div style={{backgroundImage:`url(${JSON.stringify(item.public_url)})`}} role="img" aria-label={item.alt_text}/><p><b>{item.role}</b><span>{item.scope==="HOTEL"?"호텔":data.rooms.find(room=>room.id===item.room_type_id)?.code||"객실"}</span></p><small>{item.alt_text}</small>{canAdmin&&<button type="button" disabled={Boolean(busy)} onClick={async()=>{if(window.confirm("이 이미지를 홈페이지와 Storage에서 삭제할까요?")&&await act("delete_website_media",{mediaId:item.id}))await load();}}>삭제</button>}</article>)}{!data.media.length&&<div className="empty-state"><b>등록된 이미지가 없습니다</b><p>기본 Aurora 아트가 표시됩니다. 호텔 또는 객실 이미지를 업로드해 보세요.</p></div>}</div></section></div>}
  </section>;
}
