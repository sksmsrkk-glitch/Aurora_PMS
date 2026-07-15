import { sql } from "drizzle-orm";
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
export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), topic: text("topic").notNull(), aggregateType: text("aggregate_type").notNull(), aggregateId: text("aggregate_id").notNull(), payloadJson: text("payload_json").notNull(), status: text("status").notNull().default("PENDING"), attempts: integer("attempts").notNull().default(0), createdAt: text("created_at").notNull(), publishedAt: text("published_at"),
}, (t) => [index("outbox_pending_idx").on(t.status, t.createdAt)]);
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(), propertyId: text("property_id").notNull(), action: text("action").notNull(), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
});
export const roleAssignments = sqliteTable("role_assignments", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), email: text("email").notNull(), role: text("role").notNull(), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("role_property_email_uq").on(t.propertyId, t.email)]);
export const cashierSessions = sqliteTable("cashier_sessions", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), actor: text("actor").notNull(), businessDate: text("business_date").notNull(), status: text("status").notNull(), openingAmount: real("opening_amount").notNull(), expectedAmount: real("expected_amount"), countedAmount: real("counted_amount"), variance: real("variance"), openedAt: text("opened_at").notNull(), closedAt: text("closed_at"),
}, (t) => [index("cashier_open_idx").on(t.propertyId, t.status, t.actor), uniqueIndex("cashier_actor_open_uq").on(t.propertyId,t.actor).where(sql`${t.status} = 'OPEN'`)]);
export const nightAudits = sqliteTable("night_audits", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), businessDate: text("business_date").notNull(), status: text("status").notNull(), blockersJson: text("blockers_json").notNull(), summaryJson: text("summary_json"), startedAt: text("started_at").notNull(), completedAt: text("completed_at"), completedBy: text("completed_by"),
}, (t) => [uniqueIndex("night_audit_property_date_uq").on(t.propertyId, t.businessDate)]);
export const reservationTransitions = sqliteTable("reservation_transitions", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), fromStatus: text("from_status").notNull(), toStatus: text("to_status").notNull(), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("reservation_transition_from_uq").on(t.propertyId, t.reservationId, t.fromStatus)]);
