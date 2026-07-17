/** Read-only public-site smoke: SEO, isolated CSS, sitemap and booking search. */
import assert from "node:assert/strict";

const baseUrl = (process.env.PMS_QA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/u, "");
const seoulToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const departureDate = new Date(`${seoulToday}T00:00:00.000Z`);
departureDate.setUTCDate(departureDate.getUTCDate() + 1);
const departure = departureDate.toISOString().slice(0, 10);

async function text(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html,application/xml" } });
  const body = await response.text();
  assert.equal(response.status, 200, `${path} returned ${response.status}: ${body.slice(0, 200)}`);
  return { response, body };
}

const hotel = await text("/hotel");
assert.match(hotel.body, /<link[^>]+rel="canonical"/u);
assert.match(hotel.body, /<script[^>]+type="application\/ld\+json"/u);
assert.doesNotMatch(hotel.body, /toss\.im|Toss Product Sans/u);
const stylesheets = Array.from(hotel.body.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu), (match) => match[1]);
assert.ok(stylesheets.length >= 1, "hotel page must load its isolated stylesheet");
for (const href of stylesheets) {
  const css = await (await fetch(new URL(href, baseUrl))).text();
  assert.doesNotMatch(css, /\.pms-shell|\.flow-sidebar|\.report-workspace/u, "public CSS contains PMS workspace rules");
}

const booking = await text("/hotel/book");
assert.match(booking.body, /객실 예약/u);
const sitemap = await text("/sitemap.xml");
assert.match(sitemap.body, /\/hotel<\/loc>/u);
assert.match(sitemap.body, /\/hotel\/book<\/loc>/u);

const availability = await fetch(`${baseUrl}/api/booking/availability?arrival=${seoulToday}&departure=${departure}&adults=2&children=0`);
const availabilityBody = await availability.json();
assert.equal(availability.status, 200, availabilityBody?.error || "availability failed");
assert.ok(Array.isArray(availabilityBody.offers), "availability must return an offers array");

console.log(JSON.stringify({
  hotelStatus: hotel.response.status,
  bookingStatus: booking.response.status,
  sitemapStatus: sitemap.response.status,
  stylesheetCount: stylesheets.length,
  availableOffers: availabilityBody.offers.length,
  cssIsolated: true,
  seoReady: true,
}));
