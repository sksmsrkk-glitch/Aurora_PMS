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
export const reservationTypeNights = sqliteTable("reservation_type_nights", {
  id: integer("id").primaryKey({ autoIncrement: true }), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), roomTypeId: text("room_type_id").notNull(), stayDate: text("stay_date").notNull(),
}, (t) => [uniqueIndex("reservation_type_night_uq").on(t.reservationId, t.stayDate), index("type_night_inventory_idx").on(t.propertyId, t.roomTypeId, t.stayDate)]);
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
export const reservationMutations = sqliteTable("reservation_mutations", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), expectedVersion: integer("expected_version").notNull(), kind: text("kind").notNull(), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("reservation_mutation_version_uq").on(t.propertyId, t.reservationId, t.expectedVersion)]);
export const inventoryControls = sqliteTable("inventory_controls", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), roomTypeId: text("room_type_id").notNull(), stayDate: text("stay_date").notNull(), sellLimit: integer("sell_limit"), closed: integer("closed", { mode:"boolean" }).notNull().default(false), minStay: integer("min_stay").notNull().default(1), closeToArrival: integer("close_to_arrival", { mode:"boolean" }).notNull().default(false), closeToDeparture: integer("close_to_departure", { mode:"boolean" }).notNull().default(false), priceOverride: real("price_override"), updatedAt: text("updated_at").notNull(), updatedBy: text("updated_by").notNull(),
}, (t) => [uniqueIndex("inventory_control_type_date_uq").on(t.propertyId, t.roomTypeId, t.stayDate), index("inventory_control_calendar_idx").on(t.propertyId, t.stayDate)]);
export const roomMoves = sqliteTable("room_moves", {
  id: text("id").primaryKey(), propertyId: text("property_id").notNull(), reservationId: text("reservation_id").notNull(), fromRoomId: text("from_room_id"), toRoomId: text("to_room_id").notNull(), moveDate: text("move_date").notNull(), reason: text("reason").notNull(), notes: text("notes").notNull().default(""), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [index("room_move_reservation_idx").on(t.propertyId, t.reservationId, t.createdAt)]);
export const accountProfiles = sqliteTable("account_profiles", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), type:text("type").notNull(), name:text("name").notNull(), externalId:text("external_id"), email:text("email"), phone:text("phone"), negotiatedRateCode:text("negotiated_rate_code"), creditStatus:text("credit_status").notNull().default("CASH"), notes:text("notes").notNull().default(""), active:integer("active",{mode:"boolean"}).notNull().default(true), version:integer("version").notNull().default(1), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
}, (t)=>[uniqueIndex("account_profile_external_uq").on(t.propertyId,t.type,t.externalId),index("account_profile_search_idx").on(t.propertyId,t.type,t.name)]);
export const businessBlocks = sqliteTable("business_blocks", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), code:text("code").notNull(), name:text("name").notNull(), accountProfileId:text("account_profile_id"), groupProfileId:text("group_profile_id"), arrivalDate:text("arrival_date").notNull(), departureDate:text("departure_date").notNull(), status:text("status").notNull(), reservationMethod:text("reservation_method").notNull(), deductInventory:integer("deduct_inventory",{mode:"boolean"}).notNull().default(true), cutoffDate:text("cutoff_date"), currency:text("currency").notNull(), notes:text("notes").notNull().default(""), version:integer("version").notNull().default(1), cutoffProcessedAt:text("cutoff_processed_at"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},(t)=>[uniqueIndex("business_block_code_uq").on(t.propertyId,t.code),index("business_block_dates_idx").on(t.propertyId,t.arrivalDate,t.departureDate,t.status)]);
export const blockInventory = sqliteTable("block_inventory", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), blockId:text("block_id").notNull(), roomTypeId:text("room_type_id").notNull(), stayDate:text("stay_date").notNull(), originalRooms:integer("original_rooms").notNull(), currentRooms:integer("current_rooms").notNull(), pickedUp:integer("picked_up").notNull().default(0), rate:real("rate").notNull(), cutoffDate:text("cutoff_date"), version:integer("version").notNull().default(1), updatedAt:text("updated_at").notNull(),
},(t)=>[uniqueIndex("block_inventory_type_date_uq").on(t.blockId,t.roomTypeId,t.stayDate),index("block_inventory_house_idx").on(t.propertyId,t.roomTypeId,t.stayDate)]);
export const roomingListEntries = sqliteTable("rooming_list_entries", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), blockId:text("block_id").notNull(), firstName:text("first_name").notNull(), lastName:text("last_name").notNull(), email:text("email"), phone:text("phone"), arrivalDate:text("arrival_date").notNull(), departureDate:text("departure_date").notNull(), roomTypeId:text("room_type_id").notNull(), status:text("status").notNull(), reservationId:text("reservation_id"), rate:real("rate").notNull(), notes:text("notes").notNull().default(""), version:integer("version").notNull().default(1), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},(t)=>[index("rooming_list_block_idx").on(t.blockId,t.status,t.lastName),uniqueIndex("rooming_list_reservation_uq").on(t.reservationId)]);
export const blockPickupNights = sqliteTable("block_pickup_nights", {
  id:integer("id").primaryKey({autoIncrement:true}), propertyId:text("property_id").notNull(), blockId:text("block_id").notNull(), roomingEntryId:text("rooming_entry_id").notNull(), roomTypeId:text("room_type_id").notNull(), stayDate:text("stay_date").notNull(), createdAt:text("created_at").notNull(),
},(t)=>[uniqueIndex("block_pickup_entry_date_uq").on(t.roomingEntryId,t.stayDate),index("block_pickup_block_date_idx").on(t.blockId,t.roomTypeId,t.stayDate)]);
export const folioWindows = sqliteTable("folio_windows", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), reservationId:text("reservation_id").notNull(), windowNo:integer("window_no").notNull(), name:text("name").notNull(), payeeType:text("payee_type").notNull().default("GUEST"), payeeAccountProfileId:text("payee_account_profile_id"), status:text("status").notNull().default("OPEN"), createdAt:text("created_at").notNull(), createdBy:text("created_by").notNull(), closedAt:text("closed_at"),
},(t)=>[uniqueIndex("folio_window_reservation_no_uq").on(t.reservationId,t.windowNo),index("folio_window_property_idx").on(t.propertyId,t.status)]);
export const folioEntryDetails = sqliteTable("folio_entry_details", {
  entryId:text("entry_id").primaryKey(), propertyId:text("property_id").notNull(), reservationId:text("reservation_id").notNull(), folioWindowId:text("folio_window_id").notNull(), netAmount:real("net_amount").notNull(), taxAmount:real("tax_amount").notNull().default(0), serviceAmount:real("service_amount").notNull().default(0), currency:text("currency").notNull(), sourceEntryId:text("source_entry_id"), reason:text("reason"), createdAt:text("created_at").notNull(),
},(t)=>[index("folio_detail_window_idx").on(t.folioWindowId,t.createdAt),index("folio_detail_source_idx").on(t.sourceEntryId)]);
export const folioRoutingRules = sqliteTable("folio_routing_rules", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), reservationId:text("reservation_id").notNull(), transactionCode:text("transaction_code").notNull(), targetWindowId:text("target_window_id").notNull(), active:integer("active",{mode:"boolean"}).notNull().default(true), createdAt:text("created_at").notNull(), createdBy:text("created_by").notNull(),
},(t)=>[uniqueIndex("folio_routing_reservation_code_uq").on(t.reservationId,t.transactionCode),index("folio_routing_target_idx").on(t.targetWindowId,t.active)]);
export const transactionCodes = sqliteTable("transaction_codes", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), code:text("code").notNull(), name:text("name").notNull(), category:text("category").notNull(), taxRate:real("tax_rate").notNull().default(0), serviceRate:real("service_rate").notNull().default(0), active:integer("active",{mode:"boolean"}).notNull().default(true),
},(t)=>[uniqueIndex("transaction_code_property_uq").on(t.propertyId,t.code)]);
export const arAccounts = sqliteTable("ar_accounts", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), accountProfileId:text("account_profile_id").notNull(), accountNo:text("account_no").notNull(), name:text("name").notNull(), creditLimit:real("credit_limit").notNull().default(0), status:text("status").notNull().default("ACTIVE"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},(t)=>[uniqueIndex("ar_account_profile_uq").on(t.propertyId,t.accountProfileId),uniqueIndex("ar_account_no_uq").on(t.propertyId,t.accountNo)]);
export const arInvoices = sqliteTable("ar_invoices", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), arAccountId:text("ar_account_id").notNull(), reservationId:text("reservation_id").notNull(), folioWindowId:text("folio_window_id").notNull(), invoiceNo:text("invoice_no").notNull(), issuedDate:text("issued_date").notNull(), dueDate:text("due_date").notNull(), subtotal:real("subtotal").notNull(), taxAmount:real("tax_amount").notNull(), serviceAmount:real("service_amount").notNull(), total:real("total").notNull(), status:text("status").notNull(), createdAt:text("created_at").notNull(), createdBy:text("created_by").notNull(),
},(t)=>[uniqueIndex("ar_invoice_no_uq").on(t.propertyId,t.invoiceNo),index("ar_invoice_account_due_idx").on(t.arAccountId,t.status,t.dueDate)]);
export const arLedgerEntries = sqliteTable("ar_ledger_entries", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), arAccountId:text("ar_account_id").notNull(), invoiceId:text("invoice_id"), kind:text("kind").notNull(), debit:real("debit").notNull().default(0), credit:real("credit").notNull().default(0), businessDate:text("business_date").notNull(), paymentMethod:text("payment_method"), memo:text("memo").notNull(), createdAt:text("created_at").notNull(), createdBy:text("created_by").notNull(), reversesEntryId:text("reverses_entry_id"),
},(t)=>[index("ar_ledger_account_idx").on(t.arAccountId,t.businessDate,t.createdAt),index("ar_ledger_invoice_idx").on(t.invoiceId)]);
export const channelConnections = sqliteTable("channel_connections", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), provider:text("provider").notNull(), externalPropertyId:text("external_property_id").notNull(), name:text("name").notNull(), environment:text("environment").notNull().default("SANDBOX"), status:text("status").notNull().default("ACTIVE"), lastSyncAt:text("last_sync_at"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(), createdBy:text("created_by").notNull(),
},(t)=>[uniqueIndex("channel_connection_provider_property_uq").on(t.propertyId,t.provider,t.externalPropertyId),index("channel_connection_status_idx").on(t.propertyId,t.status)]);
export const channelMappings = sqliteTable("channel_mappings", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), connectionId:text("connection_id").notNull(), roomTypeId:text("room_type_id").notNull(), externalRoomTypeId:text("external_room_type_id").notNull(), ratePlan:text("rate_plan").notNull(), externalRatePlanId:text("external_rate_plan_id").notNull(), active:integer("active",{mode:"boolean"}).notNull().default(true), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},(t)=>[uniqueIndex("channel_mapping_external_uq").on(t.connectionId,t.externalRoomTypeId,t.externalRatePlanId),index("channel_mapping_internal_idx").on(t.propertyId,t.roomTypeId,t.ratePlan)]);
export const ariUpdates = sqliteTable("ari_updates", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), connectionId:text("connection_id").notNull(), mappingId:text("mapping_id").notNull(), stayDate:text("stay_date").notNull(), revision:integer("revision").notNull(), available:integer("available").notNull(), closed:integer("closed",{mode:"boolean"}).notNull().default(false), minStay:integer("min_stay").notNull().default(1), closeToArrival:integer("close_to_arrival",{mode:"boolean"}).notNull().default(false), closeToDeparture:integer("close_to_departure",{mode:"boolean"}).notNull().default(false), rate:real("rate").notNull(), currency:text("currency").notNull(), payloadJson:text("payload_json").notNull(), status:text("status").notNull().default("PENDING"), attempts:integer("attempts").notNull().default(0), createdAt:text("created_at").notNull(), sentAt:text("sent_at"), lastError:text("last_error"),
},(t)=>[uniqueIndex("ari_update_revision_uq").on(t.mappingId,t.stayDate,t.revision),index("ari_update_dispatch_idx").on(t.status,t.createdAt)]);
export const channelReservationLinks = sqliteTable("channel_reservation_links", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), connectionId:text("connection_id").notNull(), externalReservationId:text("external_reservation_id").notNull(), reservationId:text("reservation_id").notNull(), lastRevision:integer("last_revision").notNull(), status:text("status").notNull(), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},(t)=>[uniqueIndex("channel_reservation_external_uq").on(t.connectionId,t.externalReservationId),uniqueIndex("channel_reservation_internal_uq").on(t.connectionId,t.reservationId)]);
export const inboundChannelMessages = sqliteTable("inbound_channel_messages", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), connectionId:text("connection_id").notNull(), provider:text("provider").notNull(), messageId:text("message_id").notNull(), eventType:text("event_type").notNull(), externalReservationId:text("external_reservation_id").notNull(), revision:integer("revision").notNull(), payloadJson:text("payload_json").notNull(), status:text("status").notNull().default("PENDING"), attempts:integer("attempts").notNull().default(0), reservationId:text("reservation_id"), lastError:text("last_error"), receivedAt:text("received_at").notNull(), processedAt:text("processed_at"),
},(t)=>[uniqueIndex("inbound_channel_message_uq").on(t.connectionId,t.messageId),index("inbound_channel_dlq_idx").on(t.status,t.receivedAt)]);
export const integrationDeliveryAttempts = sqliteTable("integration_delivery_attempts", {
  id:text("id").primaryKey(), propertyId:text("property_id").notNull(), direction:text("direction").notNull(), provider:text("provider").notNull(), aggregateType:text("aggregate_type").notNull(), aggregateId:text("aggregate_id").notNull(), attemptNo:integer("attempt_no").notNull(), status:text("status").notNull(), httpStatus:integer("http_status"), errorCode:text("error_code"), errorMessage:text("error_message"), payloadJson:text("payload_json").notNull(), createdAt:text("created_at").notNull(), createdBy:text("created_by").notNull(),
},(t)=>[index("integration_attempt_aggregate_idx").on(t.aggregateType,t.aggregateId,t.attemptNo),index("integration_attempt_failure_idx").on(t.status,t.createdAt)]);
