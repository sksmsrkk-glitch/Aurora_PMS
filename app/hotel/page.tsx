/** Public Aurora Hotel site, fully projected from the PMS website CMS. */
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWebsiteContent } from "../api/booking/website-service";
import HotelSearchForm from "./HotelSearchForm";

export const dynamic = "force-dynamic";

function dateAfter(days: number) {
  const date = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const money = (value: number) => new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(value);

export default async function AuroraHotelPage() {
  const content = await getWebsiteContent();
  if (!content.published) notFound();
  const arrival = dateAfter(1);
  const departure = dateAfter(2);
  const hero = content.hotelMedia.find((item) => item.role === "HERO") || content.hotelMedia[0];
  const { settings } = content;

  return <main className="hotel-site">
    <nav className="hotel-nav" aria-label="호텔 홈페이지">
      <Link className="hotel-brand" href="/hotel"><Image src="/brand/aurora-mark-192.png" alt="" width={42} height={42} priority/><span><b>AURORA</b><small>SEOUL</small></span></Link>
      <div className="hotel-nav-links"><a href="#stay">STAY</a><a href="#experience">EXPERIENCE</a><a href="#location">LOCATION</a></div>
      <Link className="hotel-nav-book" href={`/hotel/book?arrival=${arrival}&departure=${departure}&adults=2&children=0`}>예약하기</Link>
    </nav>

    <section className={`hotel-hero ${hero?"has-cms-image":""}`} style={hero?{backgroundImage:`linear-gradient(90deg,rgba(5,13,29,.74),rgba(5,13,29,.24)),url(${JSON.stringify(hero.url)})`}:undefined}>
      <div className="aurora-sky" aria-hidden="true"><i/><i/><i/><span/></div>
      <div className="hotel-hero-copy">
        <p>{settings.brandEyebrow}</p>
        <h1>{settings.heroTitle}</h1>
        <span>{settings.heroSubtitle}</span>
      </div>
      <HotelSearchForm minimumArrival={arrival} initialDeparture={departure}/>
    </section>

    <section className="hotel-intro" id="stay">
      <p>THE AURORA STAY</p>
      <h2>{settings.overviewTitle}</h2>
      <span>{settings.overviewBody}</span>
      <div className="hotel-room-preview">
        {content.rooms.map((room,index)=>{
          const image=room.media.find((item)=>item.role==="CARD")||room.media[0];
          return <article key={room.id}>
            <i className={`room-art ${image?"cms-room-image":`art-${["one","two","three"][index%3]}`}`} style={image?{backgroundImage:`url(${JSON.stringify(image.url)})`}:undefined}/>
            <small>{room.code} · {money(room.baseRate)}부터</small>
            <h3>{room.marketingName}</h3>
            <p>{room.shortDescription}</p>
          </article>;
        })}
      </div>
    </section>

    <section className="hotel-experience" id="experience">
      <div><p>A MOMENT FOR YOU</p><h2>{settings.experienceTitle}</h2></div>
      <div className="experience-grid"><article><b>07:00</b><h3>Seasonal Breakfast</h3><p>제철 식재료로 가볍고 충실하게 시작하는 아침</p></article><article><b>18:00</b><h3>Sunset Lounge</h3><p>서울의 저녁빛과 함께하는 시그니처 티와 칵테일</p></article><article><b>24H</b><h3>Quiet Fitness</h3><p>여행의 리듬을 지켜주는 프라이빗 피트니스</p></article></div>
      <p className="experience-body">{settings.experienceBody}</p>
    </section>

    <section className="hotel-location" id="location"><div><p>IN THE HEART OF SEOUL</p><h2>{settings.locationTitle}</h2><span>{settings.locationBody}<br/>{settings.address} · {settings.phone}</span></div><div className="location-orbit" aria-hidden="true"><i/><i/><b>AURORA</b></div></section>
    <footer className="hotel-footer"><div className="hotel-brand"><Image src="/brand/aurora-mark-192.png" alt="" width={38} height={38}/><span><b>AURORA</b><small>SEOUL</small></span></div><p>© 2026 {settings.hotelName}. All rights reserved.</p><Link href="/login">PMS 로그인</Link></footer>
  </main>;
}
