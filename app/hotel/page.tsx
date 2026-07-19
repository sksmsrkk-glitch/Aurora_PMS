/** Public Aurora Hotel site, fully projected from the PMS website CMS. */
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { headers } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import HotelSearchForm from "./HotelSearchForm";
import { hotelStructuredData, serializeJsonLd } from "./seo";
import { formatMoney, seoulDateAfter } from "../../lib/format";
import { getCachedWebsiteContent } from "./content";
import type { WebsiteSectionId } from "../website-editor-contract";
import { resolvePublicPropertyForRequest } from "../api/booking/property-resolver";

// Published CMS content is refreshed at most one minute after an administrator
// changes it without forcing every public request through a server render.
export const revalidate = 60;

const money = formatMoney;

export default async function AuroraHotelPage() {
  // Database-backed CMS rendering starts on the first request, so a release can
  // build before its matching migration is promoted. The projection itself is
  // cached for 60 seconds by getCachedWebsiteContent.
  await connection();
  const property=await resolvePublicPropertyForRequest({headers:await headers()});
  if(!property)notFound();
  const content = await getCachedWebsiteContent(property.propertyId);
  if (!content.published) notFound();
  const arrival = seoulDateAfter(1);
  const departure = seoulDateAfter(2);
  const { settings } = content;
  const hero = content.hotelMedia.find((item) => item.id === settings.heroMediaId)
    || content.hotelMedia.find((item) => item.role === "HERO")
    || content.hotelMedia[0];
  const bookHref = `${property.pathPrefix}/book?arrival=${arrival}&departure=${departure}&adults=2&children=0`;
  const heroCtaHref = settings.heroCtaHref === "/hotel/book" ? bookHref : settings.heroCtaHref;
  const overlay = settings.heroOverlay / 100;
  const siteStyle = { "--hotel-blue": settings.themeAccent } as CSSProperties;
  const heroStyle = {
    "--hotel-hero-height": `${settings.heroHeight}px`,
    ...(hero ? { backgroundImage: `linear-gradient(90deg,rgba(5,13,29,${Math.min(.92, overlay + .14)}),rgba(5,13,29,${Math.max(.08, overlay * .38)})),url(${JSON.stringify(hero.url)})` } : {}),
  } as CSSProperties;

  const sections: Record<WebsiteSectionId, ReactNode> = {
    stay: <section className="hotel-intro" id="stay" key="stay">
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
    </section>,
    experience: <section className="hotel-experience" id="experience" key="experience">
      <div><p>A MOMENT FOR YOU</p><h2>{settings.experienceTitle}</h2></div>
      <div className="experience-grid"><article><b>07:00</b><h3>Seasonal Breakfast</h3><p>제철 식재료로 가볍고 충실하게 시작하는 아침</p></article><article><b>18:00</b><h3>Sunset Lounge</h3><p>서울의 저녁빛과 함께하는 시그니처 티와 칵테일</p></article><article><b>24H</b><h3>Quiet Fitness</h3><p>여행의 리듬을 지켜주는 프라이빗 피트니스</p></article></div>
      <p className="experience-body">{settings.experienceBody}</p>
    </section>,
    location: <section className="hotel-location" id="location" key="location"><div><p>IN THE HEART OF SEOUL</p><h2>{settings.locationTitle}</h2><span>{settings.locationBody}<br/>{settings.address} · {settings.phone}</span></div><div className="location-orbit" aria-hidden="true"><i/><i/><b>AURORA</b></div></section>,
  };

  return <main className="hotel-site" style={siteStyle}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{__html:serializeJsonLd(hotelStructuredData(content,property))}}/>
    <nav className="hotel-nav" aria-label="호텔 홈페이지">
      <Link className="hotel-brand" href={property.pathPrefix||"/"}><Image src="/brand/aurora-mark-192.png" alt="" width={42} height={42} priority/><span><b>AURORA</b><small>SEOUL</small></span></Link>
      <div className="hotel-nav-links">{settings.navigation.filter((item)=>item.enabled).map((item)=><a href={`#${item.id}`} key={item.id}>{item.label}</a>)}</div>
      <Link className="hotel-nav-book" href={bookHref}>{settings.bookingCtaLabel}</Link>
    </nav>

    <section className={`hotel-hero hero-layout-${settings.heroLayout.toLowerCase()} ${hero?"has-cms-image":""}`} style={heroStyle}>
      <div className="aurora-sky" aria-hidden="true"><i/><i/><i/><span/></div>
      <div className="hotel-hero-copy">
        <p>{settings.brandEyebrow}</p>
        <h1>{settings.heroTitle}</h1>
        <span>{settings.heroSubtitle}</span>
        <a className="hotel-hero-cta" href={heroCtaHref}>{settings.heroCtaLabel}<i aria-hidden="true">→</i></a>
      </div>
      <HotelSearchForm minimumArrival={arrival} initialDeparture={departure}/>
    </section>

    {settings.navigation.filter((item)=>item.enabled).map((item)=>sections[item.id])}
    <footer className="hotel-footer"><div className="hotel-brand"><Image src="/brand/aurora-mark-192.png" alt="" width={38} height={38}/><span><b>AURORA</b><small>SEOUL</small></span></div><p>© 2026 {settings.hotelName}. All rights reserved.</p><Link href="/login">PMS 로그인</Link></footer>
  </main>;
}
