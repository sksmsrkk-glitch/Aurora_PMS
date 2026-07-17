/** Pure behavior tests for canonical metadata and structured hotel data. */
import test from "node:test";
import assert from "node:assert/strict";
import { bookingMetadata, hotelMetadata, hotelStructuredData, publicSiteUrl, serializeJsonLd } from "../app/hotel/seo.ts";

const content = {
  published: true,
  settings: {
    hotelName: "Aurora Seoul",
    brandEyebrow: "Aurora",
    heroTitle: "A quiet stay",
    heroSubtitle: "서울의 빛을 담은 호텔",
    overviewTitle: "Stay",
    overviewBody: "도심에서 편안하게 머무는 공식 홈페이지입니다.",
    experienceTitle: "Experience",
    experienceBody: "Experience Aurora",
    locationTitle: "Seoul",
    locationBody: "서울 중심",
    address: "서울특별시 중구 세종대로",
    phone: "+82-2-0000-0000",
    email: "stay@example.com",
    checkinTime: "15:00:00",
    checkoutTime: "11:00:00",
  },
  hotelMedia: [{ id:"hero",scope:"HOTEL",roomTypeId:null,role:"HERO",url:"https://images.example/hotel.jpg",alt:"Aurora",sortOrder:0 }],
  rooms: [{ id:"deluxe",code:"DLX",name:"Deluxe",marketingName:"디럭스",shortDescription:"편안한 객실",longDescription:"편안한 객실",capacity:2,baseRate:220000,displayOrder:1,amenities:["Wi-Fi"],media:[] }],
};

test("hotel metadata publishes trusted canonical and social discovery fields", () => {
  const previous = process.env.AURORA_PUBLIC_SITE_URL;
  process.env.AURORA_PUBLIC_SITE_URL = "https://stay.aurora.example/some/path?ignored=true";
  try {
    const metadata = hotelMetadata(content);
    assert.equal(publicSiteUrl().toString(), "https://stay.aurora.example/");
    assert.equal(metadata.alternates.canonical, "/hotel");
    assert.equal(metadata.robots.index, true);
    assert.equal(metadata.openGraph.siteName, "Aurora Seoul");
    assert.equal(bookingMetadata(content).robots.index, false);
  } finally {
    if (previous === undefined) delete process.env.AURORA_PUBLIC_SITE_URL;
    else process.env.AURORA_PUBLIC_SITE_URL = previous;
  }
});

test("hotel JSON-LD exposes rooms and cannot break out of its script element", () => {
  const unsafe = structuredClone(content);
  unsafe.settings.overviewBody = "Safe </script><script>alert(1)</script>";
  const structured = hotelStructuredData(unsafe);
  assert.equal(structured["@type"], "Hotel");
  assert.equal(structured.makesOffer[0].itemOffered["@type"], "HotelRoom");
  const serialized = serializeJsonLd(structured);
  assert.equal(serialized.includes("<"), false);
  assert.match(serialized, /\\u003c\/script/iu);
});
