/**
 * Read-only website projection shared by the public hotel page.
 *
 * The browser never receives a database credential: this module runs on the
 * server and selects only content explicitly published by a PMS administrator.
 */
import { getPmsDatabase, type PmsRuntimeBindings } from "../../../db/pms-database";

const bindings: PmsRuntimeBindings = {
  DATABASE_URL: process.env.DATABASE_URL,
};

export type WebsiteMedia = {
  id: string;
  scope: "HOTEL" | "ROOM_TYPE";
  roomTypeId: string | null;
  role: "HERO" | "GALLERY" | "CARD";
  url: string;
  alt: string;
  sortOrder: number;
};

export type WebsiteRoom = {
  id: string;
  code: string;
  name: string;
  marketingName: string;
  shortDescription: string;
  longDescription: string;
  capacity: number;
  baseRate: number;
  displayOrder: number;
  amenities: string[];
  media: WebsiteMedia[];
};

export type WebsiteContent = {
  published: boolean;
  settings: {
    hotelName: string;
    brandEyebrow: string;
    heroTitle: string;
    heroSubtitle: string;
    overviewTitle: string;
    overviewBody: string;
    experienceTitle: string;
    experienceBody: string;
    locationTitle: string;
    locationBody: string;
    address: string;
    phone: string;
    email: string;
    checkinTime: string;
    checkoutTime: string;
  };
  hotelMedia: WebsiteMedia[];
  rooms: WebsiteRoom[];
};

function safeStringArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function mediaFromRow(row: Record<string, unknown>): WebsiteMedia {
  return {
    id: String(row.id),
    scope: String(row.scope) as WebsiteMedia["scope"],
    roomTypeId: row.room_type_id == null ? null : String(row.room_type_id),
    role: String(row.role) as WebsiteMedia["role"],
    url: String(row.public_url),
    alt: String(row.alt_text),
    sortOrder: Number(row.sort_order),
  };
}

/** Loads the currently published hotel and room merchandising projection. */
export async function getWebsiteContent(): Promise<WebsiteContent> {
  const db = getPmsDatabase(bindings);
  const [settingsResult, roomResult, mediaResult] = await db.batch([
    db.prepare("SELECT * FROM website_settings WHERE property_id='prop-seoul' LIMIT 1"),
    db.prepare("SELECT rt.id,rt.code,rt.name,rt.base_rate,rt.capacity,rw.marketing_name,rw.short_description,rw.long_description,rw.amenities_json,rw.display_order FROM room_types rt JOIN room_type_website rw ON rw.property_id=rt.property_id AND rw.room_type_id=rt.id WHERE rt.property_id='prop-seoul' AND rt.active=1 AND rw.published=1 ORDER BY rw.display_order,rt.base_rate,rt.code"),
    db.prepare("SELECT id,scope,room_type_id,role,public_url,alt_text,sort_order FROM website_media WHERE property_id='prop-seoul' AND active=1 ORDER BY scope,room_type_id,sort_order,created_at"),
  ]);
  const row = settingsResult.results[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("Website content is not initialized");
  const media = mediaResult.results.map((item) => mediaFromRow(item));
  return {
    published: Boolean(row.published),
    settings: {
      hotelName: String(row.hotel_name),
      brandEyebrow: String(row.brand_eyebrow),
      heroTitle: String(row.hero_title),
      heroSubtitle: String(row.hero_subtitle),
      overviewTitle: String(row.overview_title),
      overviewBody: String(row.overview_body),
      experienceTitle: String(row.experience_title),
      experienceBody: String(row.experience_body),
      locationTitle: String(row.location_title),
      locationBody: String(row.location_body),
      address: String(row.address),
      phone: String(row.phone),
      email: String(row.email),
      checkinTime: String(row.checkin_time),
      checkoutTime: String(row.checkout_time),
    },
    hotelMedia: media.filter((item) => item.scope === "HOTEL"),
    rooms: roomResult.results.map((item) => {
      const room = item as Record<string, unknown>;
      return {
        id: String(room.id),
        code: String(room.code),
        name: String(room.name),
        marketingName: String(room.marketing_name),
        shortDescription: String(room.short_description),
        longDescription: String(room.long_description),
        capacity: Number(room.capacity),
        baseRate: Number(room.base_rate),
        displayOrder: Number(room.display_order),
        amenities: safeStringArray(room.amenities_json),
        media: media.filter((image) => image.roomTypeId === String(room.id)),
      };
    }),
  };
}
