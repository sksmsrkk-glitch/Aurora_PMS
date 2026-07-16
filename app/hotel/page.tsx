import Image from "next/image";
import Link from "next/link";

export const dynamic = "force-dynamic";

function dateAfter(days: number) {
  const date = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export default function AuroraHotelPage() {
  const arrival = dateAfter(1);
  const departure = dateAfter(2);
  return <main className="hotel-site">
    <nav className="hotel-nav" aria-label="호텔 홈페이지">
      <Link className="hotel-brand" href="/hotel"><Image src="/brand/aurora-mark-192.png" alt="" width={42} height={42} priority/><span><b>AURORA</b><small>SEOUL</small></span></Link>
      <div className="hotel-nav-links"><a href="#stay">STAY</a><a href="#experience">EXPERIENCE</a><a href="#location">LOCATION</a></div>
      <Link className="hotel-nav-book" href={`/hotel/book?arrival=${arrival}&departure=${departure}&adults=2&children=0`}>예약하기</Link>
    </nav>

    <section className="hotel-hero">
      <div className="aurora-sky" aria-hidden="true"><i/><i/><i/><span/></div>
      <div className="hotel-hero-copy">
        <p>URBAN NIGHTS, QUIETLY BRIGHT</p>
        <h1>도시의 밤이<br/>가장 편안해지는 곳</h1>
        <span>정제된 객실과 세심한 서비스. 서울의 리듬을 오롯이 누리는 새로운 스테이.</span>
      </div>
      <form className="hotel-search-card" action="/hotel/book" method="get">
        <label><span>체크인</span><input type="date" name="arrival" min={arrival} defaultValue={arrival} required/></label>
        <label><span>체크아웃</span><input type="date" name="departure" min={departure} defaultValue={departure} required/></label>
        <label><span>성인</span><select name="adults" defaultValue="2">{[1,2,3,4,5,6].map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>어린이</span><select name="children" defaultValue="0">{[0,1,2,3,4].map(value=><option key={value}>{value}</option>)}</select></label>
        <button>객실 검색</button>
      </form>
    </section>

    <section className="hotel-intro" id="stay">
      <p>THE AURORA STAY</p>
      <h2>머무는 시간에 집중한<br/>세 가지 객실</h2>
      <span>과장된 장식 대신 편안한 동선, 부드러운 빛, 깊은 휴식을 설계했습니다.</span>
      <div className="hotel-room-preview">
        <article><i className="room-art art-one"/><small>DELUXE KING</small><h3>디럭스 킹</h3><p>도시를 바라보는 킹 베드와 차분한 워크 라운지</p></article>
        <article><i className="room-art art-two"/><small>PREMIER TWIN</small><h3>프리미어 트윈</h3><p>함께하는 여행에 여유를 더한 넓은 트윈 객실</p></article>
        <article><i className="room-art art-three"/><small>CITY SUITE</small><h3>시티 스위트</h3><p>거실과 침실이 나뉜 프라이빗한 도심 속 스위트</p></article>
      </div>
    </section>

    <section className="hotel-experience" id="experience">
      <div><p>A MOMENT FOR YOU</p><h2>아침부터 깊은 밤까지<br/>당신의 속도에 맞춰</h2></div>
      <div className="experience-grid"><article><b>07:00</b><h3>Seasonal Breakfast</h3><p>제철 식재료로 가볍고 충실하게 시작하는 아침</p></article><article><b>18:00</b><h3>Sunset Lounge</h3><p>서울의 저녁빛과 함께하는 시그니처 티와 칵테일</p></article><article><b>24H</b><h3>Quiet Fitness</h3><p>여행의 리듬을 지켜주는 프라이빗 피트니스</p></article></div>
    </section>

    <section className="hotel-location" id="location"><div><p>IN THE HEART OF SEOUL</p><h2>서울을 만나는<br/>가장 좋은 시작점</h2><span>비즈니스와 문화, 미식의 중심을 가볍게 잇습니다.</span></div><div className="location-orbit" aria-hidden="true"><i/><i/><b>AURORA</b></div></section>
    <footer className="hotel-footer"><div className="hotel-brand"><Image src="/brand/aurora-mark-192.png" alt="" width={38} height={38}/><span><b>AURORA</b><small>SEOUL</small></span></div><p>© 2026 Aurora Hotel. All rights reserved.</p><Link href="/login">PMS 로그인</Link></footer>
  </main>;
}
