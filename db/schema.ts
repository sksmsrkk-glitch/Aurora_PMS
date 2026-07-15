import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const properties = sqliteTable("properties", {
  id: text("id").primaryKey(), name: text("name").notNull(), code: text("code").notNull(),
  timezone: text("timezone").notNull(), currency: text("currency").notNull(), businessDate: text("business_date").notNull(),
});
export const roomTypes = sqliteTable("room_types", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), code: text("code").notNull(), name: text("name").notNull(), baseRate: real("base_rate").notNull(), capacity: integer("capacity").notNull(),
}, (t) => [uniqueIndex("room_type_code_uq").on(t.propertyId, t.code)]);
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), roomTypeId: text("room_type_id").notNull(), number: text("number").notNull(), floor: integer("floor").notNull(),
  frontDeskStatus: text("front_desk_status").notNull(), housekeepingStatus: text("housekeeping_status").notNull(), features: text("features").notNull().default("[]"), version: integer("version").notNull().default(1),
}, (t) => [uniqueIndex("room_number_uq").on(t.propertyId, t.number), index("room_status_idx").on(t.propertyId, t.housekeepingStatus)]);
export const guests = sqliteTable("guests", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(), email: text("email"), phone: text("phone"), vipLevel: text("vip_level").notNull().default("NONE"), nationality: text("nationality"), preferences: text("preferences").notNull().default("[]"), createdAt: text("created_at").notNull(),
}, (t) => [index("guest_search_idx").on(t.propertyId, t.lastName, t.firstName)]);
export const reservations = sqliteTable("reservations", {
  id: text("id").primaryKey(), confirmationNo: text("confirmation_no").notNull(), propertyId: text("property_id").notNull(), guestId: text("guest_id").notNull(), roomTypeId: text("room_type_id").notNull(), roomId: text("room_id"),
  arrivalDate: text("arrival_date").notNull(), departureDate: text("departure_date").notNull(), status: text("status").notNull(), adults: integer("adults").notNull(), children: integer("children").notNull().default(0), source: text("source").notNull(), ratePlan: text("rate_plan").notNull(), nightlyRate: real("nightly_rate").notNull(), eta: text("eta"), notes: text("notes").notNull().default(""), version: integer("version").notNull().default(1), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("confirmation_uq").on(t.propertyId, t.confirmationNo), index("arrival_idx").on(t.propertyId, t.arrivalDate, t.status), index("room_stay_idx").on(t.roomId, t.arrivalDate, t.departureDate)]);
export const reservationNights = sqliteTable("reservation_nights", {
  id: integer("id").primaryKey({ autoIncrement: true }), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), roomId: text("room_id").notNull(), stayDate: text("stay_date").notNull(),
}, (t) => [uniqueIndex("room_night_uq").on(t.propertyId, t.roomId, t.stayDate)]);
export const folioEntries = sqliteTable("folio_entries", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), kind: text("kind").notNull(), code: text("code").notNull(), description: text("description").notNull(), amount: real("amount").notNull(), paymentMethod: text("payment_method"), businessDate: text("business_date").notNull(), createdAt: text("created_at").notNull(), createdBy: text("created_by").notNull(), reversesEntryId: text("reverses_entry_id"),
}, (t) => [index("folio_reservation_idx").on(t.reservationId, t.createdAt)]);
export const housekeepingTasks = sqliteTable("housekeeping_tasks", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), roomId: text("room_id").notNull(), businessDate: text("business_date").notNull(), status: text("status").notNull(), priority: integer("priority").notNull().default(2), assignee: text("assignee"), notes: text("notes").notNull().default(""), updatedAt: text("updated_at").notNull(),
}, (t) => [index("hk_board_idx").on(t.propertyId, t.businessDate, t.status)]);
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), actor: text("actor").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), beforeJson: text("before_json"), afterJson: text("after_json"), createdAt: text("created_at").notNull(),
}, (t) => [index("audit_entity_idx").on(t.propertyId, t.entityType, t.entityId, t.createdAt)]);
