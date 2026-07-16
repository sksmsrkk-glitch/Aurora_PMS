import { getPmsDatabase, type PmsDatabase, type PmsPreparedStatement, type PmsRuntimeBindings } from "../../../db/pms-database";
import { ReportRequestError, runReport } from "./reporting";
import { handleExtendedAction, loadAccountingCenter, loadInventoryCalendar, PmsExtendedError } from "./extended";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type D1 = PmsDatabase;
type D1PreparedStatement = PmsPreparedStatement;
type Role = "PROPERTY_ADMIN" | "NIGHT_AUDITOR" | "FRONT_DESK" | "CASHIER" | "HOUSEKEEPING" | "REVENUE_MANAGER" | "SALES_MANAGER" | "ACCOUNTANT" | "VIEWER";
type Principal = { email: string; displayName: string; role: Role; capabilities: string[] };

const runtimeBindings:PmsRuntimeBindings={
  SUPABASE_URL:process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY:process.env.SUPABASE_SECRET_KEY,
  DATABASE_URL:process.env.DATABASE_URL,
};

const roleCapabilities: Record<Role, string[]> = {
  PROPERTY_ADMIN: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "AR_WRITE", "HOUSEKEEPING_WRITE", "CASHIER_WRITE", "EOD_RUN", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT", "ADMIN"],
  NIGHT_AUDITOR: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "EOD_RUN", "REPORT_EXPORT"],
  FRONT_DESK: ["READ", "RESERVATION_WRITE", "STAY_WRITE", "FOLIO_WRITE", "CASHIER_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  CASHIER: ["READ", "FOLIO_WRITE", "AR_WRITE", "CASHIER_WRITE", "REPORT_EXPORT"],
  HOUSEKEEPING: ["READ", "HOUSEKEEPING_WRITE"],
  REVENUE_MANAGER: ["READ", "INVENTORY_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "INTEGRATION_WRITE", "REPORT_EXPORT"],
  SALES_MANAGER: ["READ", "RESERVATION_WRITE", "GROUP_WRITE", "GROUP_PICKUP", "REPORT_EXPORT"],
  ACCOUNTANT: ["READ", "FOLIO_WRITE", "AR_WRITE", "ACCOUNTING_WRITE", "REPORT_EXPORT"],
  VIEWER: ["READ"],
};

const actionCapability: Record<string, string> = {
  create_reservation: "RESERVATION_WRITE", mark_no_show: "STAY_WRITE", check_in: "STAY_WRITE", check_out: "STAY_WRITE",
  edit_reservation: "RESERVATION_WRITE", cancel_reservation: "RESERVATION_WRITE", assign_room: "RESERVATION_WRITE", move_room: "STAY_WRITE",
  update_inventory_control: "INVENTORY_WRITE", bulk_update_inventory_controls: "INVENTORY_WRITE",
  create_account_profile: "GROUP_WRITE", create_business_block: "GROUP_WRITE", update_block_inventory: "GROUP_WRITE", add_rooming_entry: "GROUP_WRITE", cutoff_block: "GROUP_WRITE",
  pickup_rooming_entry: "GROUP_PICKUP",
  post_payment: "FOLIO_WRITE", post_charge: "FOLIO_WRITE", create_folio_window: "FOLIO_WRITE", create_routing_rule: "FOLIO_WRITE", split_folio_entry: "FOLIO_WRITE", reverse_folio_entry: "FOLIO_WRITE", refund_payment: "FOLIO_WRITE",
  transfer_to_ar: "AR_WRITE", post_ar_payment: "AR_WRITE", housekeeping: "HOUSEKEEPING_WRITE",
  create_channel_connection: "INTEGRATION_WRITE", create_channel_mapping: "INTEGRATION_WRITE", upsert_channel_contract: "INTEGRATION_WRITE", queue_ari_delta: "INTEGRATION_WRITE", dispatch_ari_update: "INTEGRATION_WRITE", ingest_channel_message: "INTEGRATION_WRITE", replay_channel_message: "INTEGRATION_WRITE", dispatch_outbox_event: "INTEGRATION_WRITE",
  post_accounting_entry: "ACCOUNTING_WRITE", reverse_accounting_entry: "ACCOUNTING_WRITE", accrue_channel_settlement: "ACCOUNTING_WRITE", mark_channel_settlement_paid: "ACCOUNTING_WRITE",
  open_cashier: "CASHIER_WRITE", close_cashier: "CASHIER_WRITE", run_night_audit: "EOD_RUN",
  create_room_type: "ADMIN", update_room_type: "ADMIN", create_room: "ADMIN", update_room: "ADMIN", bulk_create_rooms: "ADMIN", export_report: "REPORT_EXPORT",
};

let initialization: Promise<void> | null = null;

const schema = [
  `CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, timezone TEXT NOT NULL, currency TEXT NOT NULL, business_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS room_types (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, base_rate REAL NOT NULL, capacity INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_type_id TEXT NOT NULL, number TEXT NOT NULL, floor INTEGER NOT NULL, front_desk_status TEXT NOT NULL, housekeeping_status TEXT NOT NULL, features TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, vip_level TEXT NOT NULL DEFAULT 'NONE', nationality TEXT, preferences TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, confirmation_no TEXT NOT NULL, property_id TEXT NOT NULL, guest_id TEXT NOT NULL, room_type_id TEXT NOT NULL, room_id TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, status TEXT NOT NULL, adults INTEGER NOT NULL, children INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, rate_plan TEXT NOT NULL, nightly_rate REAL NOT NULL, eta TEXT, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, room_id TEXT NOT NULL, stay_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_type_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS folio_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT, business_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, reverses_entry_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS housekeeping_tasks (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, assignee TEXT, notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox_events (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, topic TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, published_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, property_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS role_assignments (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cashier_sessions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, actor TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, opening_amount REAL NOT NULL, expected_amount REAL, counted_amount REAL, variance REAL, opened_at TEXT NOT NULL, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS night_audits (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, business_date TEXT NOT NULL, status TEXT NOT NULL, blockers_json TEXT NOT NULL, summary_json TEXT, started_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS reservation_transitions (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservation_mutations (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, expected_version INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inventory_controls (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, sell_limit INTEGER, closed INTEGER NOT NULL DEFAULT 0, min_stay INTEGER NOT NULL DEFAULT 1, close_to_arrival INTEGER NOT NULL DEFAULT 0, close_to_departure INTEGER NOT NULL DEFAULT 0, price_override REAL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS room_moves (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, from_room_id TEXT, to_room_id TEXT NOT NULL, move_date TEXT NOT NULL, reason TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account_profiles (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, external_id TEXT, email TEXT, phone TEXT, negotiated_rate_code TEXT, credit_status TEXT NOT NULL DEFAULT 'CASH', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS business_blocks (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, account_profile_id TEXT, group_profile_id TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, status TEXT NOT NULL, reservation_method TEXT NOT NULL, deduct_inventory INTEGER NOT NULL DEFAULT 1, cutoff_date TEXT, currency TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, cutoff_processed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS block_inventory (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, block_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, original_rooms INTEGER NOT NULL, current_rooms INTEGER NOT NULL, picked_up INTEGER NOT NULL DEFAULT 0, rate REAL NOT NULL, cutoff_date TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooming_list_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, block_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, arrival_date TEXT NOT NULL, departure_date TEXT NOT NULL, room_type_id TEXT NOT NULL, status TEXT NOT NULL, reservation_id TEXT, rate REAL NOT NULL, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS block_pickup_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id TEXT NOT NULL, block_id TEXT NOT NULL, rooming_entry_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS folio_windows (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, window_no INTEGER NOT NULL, name TEXT NOT NULL, payee_type TEXT NOT NULL DEFAULT 'GUEST', payee_account_profile_id TEXT, status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, created_by TEXT NOT NULL, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS folio_entry_details (entry_id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, folio_window_id TEXT NOT NULL, net_amount REAL NOT NULL, tax_amount REAL NOT NULL DEFAULT 0, service_amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL, source_entry_id TEXT, reason TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS folio_routing_rules (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, reservation_id TEXT NOT NULL, transaction_code TEXT NOT NULL, target_window_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS transaction_codes (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, tax_rate REAL NOT NULL DEFAULT 0, service_rate REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS ar_accounts (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, account_profile_id TEXT NOT NULL, account_no TEXT NOT NULL, name TEXT NOT NULL, credit_limit REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ar_invoices (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, ar_account_id TEXT NOT NULL, reservation_id TEXT NOT NULL, folio_window_id TEXT NOT NULL, invoice_no TEXT NOT NULL, issued_date TEXT NOT NULL, due_date TEXT NOT NULL, subtotal REAL NOT NULL, tax_amount REAL NOT NULL, service_amount REAL NOT NULL, total REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ar_ledger_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, ar_account_id TEXT NOT NULL, invoice_id TEXT, kind TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, business_date TEXT NOT NULL, payment_method TEXT, memo TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, reverses_entry_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS channel_connections (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, provider TEXT NOT NULL, external_property_id TEXT NOT NULL, name TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'SANDBOX', status TEXT NOT NULL DEFAULT 'ACTIVE', last_sync_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS channel_mappings (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, room_type_id TEXT NOT NULL, external_room_type_id TEXT NOT NULL, rate_plan TEXT NOT NULL, external_rate_plan_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ari_updates (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, mapping_id TEXT NOT NULL, stay_date TEXT NOT NULL, revision INTEGER NOT NULL, available INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, min_stay INTEGER NOT NULL DEFAULT 1, close_to_arrival INTEGER NOT NULL DEFAULT 0, close_to_departure INTEGER NOT NULL DEFAULT 0, rate REAL NOT NULL, currency TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT, last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS channel_reservation_links (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, external_reservation_id TEXT NOT NULL, reservation_id TEXT NOT NULL, last_revision INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inbound_channel_messages (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, message_id TEXT NOT NULL, event_type TEXT NOT NULL, external_reservation_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, last_error TEXT, received_at TEXT NOT NULL, processed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS integration_delivery_attempts (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, direction TEXT NOT NULL, provider TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, status TEXT NOT NULL, http_status INTEGER, error_code TEXT, error_message TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_exports (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, report_key TEXT NOT NULL, format TEXT NOT NULL, filters_json TEXT NOT NULL, row_count INTEGER NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS channel_contracts (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, contract_type TEXT NOT NULL, commission_percent REAL NOT NULL DEFAULT 0, settlement_cycle TEXT NOT NULL DEFAULT 'PER_STAY', payment_terms_days INTEGER NOT NULL DEFAULT 30, currency TEXT NOT NULL DEFAULT 'KRW', valid_from TEXT NOT NULL, valid_to TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS channel_rate_overrides (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, connection_id TEXT NOT NULL, mapping_id TEXT NOT NULL, room_type_id TEXT NOT NULL, stay_date TEXT NOT NULL, sell_rate REAL NOT NULL, net_rate REAL, currency TEXT NOT NULL DEFAULT 'KRW', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS channel_settlements (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, contract_id TEXT NOT NULL, connection_id TEXT NOT NULL, reservation_id TEXT, business_date TEXT NOT NULL, contract_type TEXT NOT NULL, commission_percent REAL NOT NULL DEFAULT 0, gross_sell_amount REAL NOT NULL, channel_cost_amount REAL NOT NULL, hotel_net_amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'KRW', due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACCRUED', paid_at TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounting_accounts (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, account_type TEXT NOT NULL, category TEXT NOT NULL, department TEXT, external_code TEXT, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounting_journal_entries (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, entry_no TEXT NOT NULL, business_date TEXT NOT NULL, entry_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT, description TEXT NOT NULL, vendor TEXT, status TEXT NOT NULL DEFAULT 'POSTED', reversal_of_id TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounting_journal_lines (id TEXT PRIMARY KEY, property_id TEXT NOT NULL, journal_entry_id TEXT NOT NULL, account_id TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, department TEXT, channel_connection_id TEXT, reservation_id TEXT, memo TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_number_uq ON rooms(property_id, number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS confirmation_uq ON reservations(property_id, confirmation_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_night_uq ON reservation_nights(property_id, room_id, stay_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_type_night_uq ON reservation_type_nights(reservation_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS type_night_inventory_idx ON reservation_type_nights(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS arrival_idx ON reservations(property_id, arrival_date, status)`,
  `CREATE INDEX IF NOT EXISTS hk_board_idx ON housekeeping_tasks(property_id, business_date, status)`,
  `CREATE INDEX IF NOT EXISTS folio_reservation_idx ON folio_entries(reservation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS role_property_email_uq ON role_assignments(property_id, email)`,
  `CREATE INDEX IF NOT EXISTS cashier_open_idx ON cashier_sessions(property_id, status, actor)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cashier_actor_open_uq ON cashier_sessions(property_id, actor) WHERE status='OPEN'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS night_audit_property_date_uq ON night_audits(property_id, business_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_transition_from_uq ON reservation_transitions(property_id, reservation_id, from_status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reservation_mutation_version_uq ON reservation_mutations(property_id, reservation_id, expected_version)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_control_type_date_uq ON inventory_controls(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS inventory_control_calendar_idx ON inventory_controls(property_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS room_move_reservation_idx ON room_moves(property_id, reservation_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_profile_external_uq ON account_profiles(property_id, type, external_id)`,
  `CREATE INDEX IF NOT EXISTS account_profile_search_idx ON account_profiles(property_id, type, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS business_block_code_uq ON business_blocks(property_id, code)`,
  `CREATE INDEX IF NOT EXISTS business_block_dates_idx ON business_blocks(property_id, arrival_date, departure_date, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS block_inventory_type_date_uq ON block_inventory(block_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS block_inventory_house_idx ON block_inventory(property_id, room_type_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS rooming_list_block_idx ON rooming_list_entries(block_id, status, last_name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rooming_list_reservation_uq ON rooming_list_entries(reservation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS block_pickup_entry_date_uq ON block_pickup_nights(rooming_entry_id, stay_date)`,
  `CREATE INDEX IF NOT EXISTS block_pickup_block_date_idx ON block_pickup_nights(block_id, room_type_id, stay_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS folio_window_reservation_no_uq ON folio_windows(reservation_id, window_no)`,
  `CREATE INDEX IF NOT EXISTS folio_window_property_idx ON folio_windows(property_id, status)`,
  `CREATE INDEX IF NOT EXISTS folio_detail_window_idx ON folio_entry_details(folio_window_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS folio_detail_source_idx ON folio_entry_details(source_entry_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS folio_routing_reservation_code_uq ON folio_routing_rules(reservation_id, transaction_code)`,
  `CREATE INDEX IF NOT EXISTS folio_routing_target_idx ON folio_routing_rules(target_window_id, active)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transaction_code_property_uq ON transaction_codes(property_id, code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ar_account_profile_uq ON ar_accounts(property_id, account_profile_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ar_account_no_uq ON ar_accounts(property_id, account_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ar_invoice_no_uq ON ar_invoices(property_id, invoice_no)`,
  `CREATE INDEX IF NOT EXISTS ar_invoice_account_due_idx ON ar_invoices(ar_account_id, status, due_date)`,
  `CREATE INDEX IF NOT EXISTS ar_ledger_account_idx ON ar_ledger_entries(ar_account_id, business_date, created_at)`,
  `CREATE INDEX IF NOT EXISTS ar_ledger_invoice_idx ON ar_ledger_entries(invoice_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_provider_property_uq ON channel_connections(property_id,provider,external_property_id)`,
  `CREATE INDEX IF NOT EXISTS channel_connection_status_idx ON channel_connections(property_id,status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_mapping_external_uq ON channel_mappings(connection_id,external_room_type_id,external_rate_plan_id)`,
  `CREATE INDEX IF NOT EXISTS channel_mapping_internal_idx ON channel_mappings(property_id,room_type_id,rate_plan)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ari_update_revision_uq ON ari_updates(mapping_id,stay_date,revision)`,
  `CREATE INDEX IF NOT EXISTS ari_update_dispatch_idx ON ari_updates(status,created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_reservation_external_uq ON channel_reservation_links(connection_id,external_reservation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_reservation_internal_uq ON channel_reservation_links(connection_id,reservation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inbound_channel_message_uq ON inbound_channel_messages(connection_id,message_id)`,
  `CREATE INDEX IF NOT EXISTS inbound_channel_dlq_idx ON inbound_channel_messages(status,received_at)`,
  `CREATE INDEX IF NOT EXISTS integration_attempt_aggregate_idx ON integration_delivery_attempts(aggregate_type,aggregate_id,attempt_no)`,
  `CREATE INDEX IF NOT EXISTS integration_attempt_failure_idx ON integration_delivery_attempts(status,created_at)`,
  `CREATE INDEX IF NOT EXISTS report_export_actor_idx ON report_exports(property_id,requested_by,created_at)`,
  `CREATE INDEX IF NOT EXISTS report_export_status_idx ON report_exports(property_id,status,created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_contract_connection_uq ON channel_contracts(connection_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_rate_mapping_date_uq ON channel_rate_overrides(mapping_id,stay_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_settlement_reservation_uq ON channel_settlements(connection_id,reservation_id) WHERE reservation_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounting_account_code_uq ON accounting_accounts(property_id,code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounting_journal_no_uq ON accounting_journal_entries(property_id,entry_no)`,
  `CREATE INDEX IF NOT EXISTS accounting_journal_line_entry_idx ON accounting_journal_lines(journal_entry_id)`,
  `CREATE INDEX IF NOT EXISTS report_reservation_filter_idx ON reservations(property_id,status,source,room_type_id,arrival_date,departure_date)`,
  `CREATE INDEX IF NOT EXISTS report_folio_business_idx ON folio_entries(property_id,business_date,kind,payment_method)`,
  `CREATE INDEX IF NOT EXISTS report_audit_created_idx ON audit_logs(property_id,created_at,action,actor)`,
  `CREATE TRIGGER IF NOT EXISTS reservation_type_nights_capacity BEFORE INSERT ON reservation_type_nights BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT closed FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),0)=1 THEN RAISE(ABORT, 'room type closed')
      WHEN (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date) + COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0) >= COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date), (SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out')
    END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS block_inventory_capacity_insert BEFORE INSERT ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`,
  `CREATE TRIGGER IF NOT EXISTS block_inventory_capacity_update BEFORE UPDATE ON block_inventory BEGIN SELECT CASE
    WHEN NEW.original_rooms<0 OR NEW.current_rooms<0 OR NEW.picked_up<0 OR NEW.current_rooms<NEW.picked_up OR NEW.rate<0 THEN RAISE(ABORT, 'invalid block inventory')
    WHEN (SELECT deduct_inventory FROM business_blocks WHERE id=NEW.block_id)=1 AND (SELECT COUNT(*) FROM reservation_type_nights WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date)+COALESCE((SELECT SUM(bi.current_rooms-bi.picked_up) FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=NEW.property_id AND bi.room_type_id=NEW.room_type_id AND bi.stay_date=NEW.stay_date AND bi.id<>OLD.id AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')),0)+(NEW.current_rooms-NEW.picked_up)>COALESCE((SELECT sell_limit FROM inventory_controls WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date),(SELECT COUNT(*) FROM rooms WHERE property_id=NEW.property_id AND room_type_id=NEW.room_type_id AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'block inventory sold out')
  END; END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_validate BEFORE INSERT ON block_pickup_nights WHEN NOT EXISTS (SELECT 1 FROM block_inventory WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date AND picked_up<current_rooms) BEGIN SELECT RAISE(ABORT, 'block allocation exhausted'); END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_increment AFTER INSERT ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=picked_up+1,version=version+1,updated_at=NEW.created_at WHERE block_id=NEW.block_id AND room_type_id=NEW.room_type_id AND stay_date=NEW.stay_date; END`,
  `CREATE TRIGGER IF NOT EXISTS block_pickup_decrement AFTER DELETE ON block_pickup_nights BEGIN UPDATE block_inventory SET picked_up=MAX(0,picked_up-1),version=version+1,updated_at=datetime('now') WHERE block_id=OLD.block_id AND room_type_id=OLD.room_type_id AND stay_date=OLD.stay_date; END`,
  `CREATE TRIGGER IF NOT EXISTS inventory_controls_validate_insert BEFORE INSERT ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END`,
  `CREATE TRIGGER IF NOT EXISTS inventory_controls_validate_update BEFORE UPDATE ON inventory_controls WHEN NEW.sell_limit < 0 OR NEW.min_stay < 1 OR NEW.price_override < 0 BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_validate_insert BEFORE INSERT ON folio_entries WHEN NEW.amount <= 0 OR NEW.kind NOT IN ('CHARGE','PAYMENT','CHARGE_REVERSAL','PAYMENT_REVERSAL','REFUND') BEGIN SELECT RAISE(ABORT, 'invalid folio entry'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_update BEFORE UPDATE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_entries_no_delete BEFORE DELETE ON folio_entries BEGIN SELECT RAISE(ABORT, 'folio entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_details_validate_insert BEFORE INSERT ON folio_entry_details WHEN NEW.net_amount<0 OR NEW.tax_amount<0 OR NEW.service_amount<0 OR ABS((NEW.net_amount+NEW.tax_amount+NEW.service_amount)-(SELECT amount FROM folio_entries WHERE id=NEW.entry_id))>0.011 OR NOT EXISTS (SELECT 1 FROM folio_windows WHERE id=NEW.folio_window_id AND reservation_id=NEW.reservation_id AND status='OPEN') BEGIN SELECT RAISE(ABORT, 'invalid folio detail'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_details_no_update BEFORE UPDATE ON folio_entry_details BEGIN SELECT RAISE(ABORT, 'folio details are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS folio_details_no_delete BEFORE DELETE ON folio_entry_details BEGIN SELECT RAISE(ABORT, 'folio details are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ar_ledger_validate_insert BEFORE INSERT ON ar_ledger_entries WHEN NEW.debit<0 OR NEW.credit<0 OR (NEW.debit=0 AND NEW.credit=0) OR (NEW.debit>0 AND NEW.credit>0) OR NEW.kind NOT IN ('INVOICE','PAYMENT','CREDIT','ADJUSTMENT','REVERSAL') BEGIN SELECT RAISE(ABORT, 'invalid ar ledger entry'); END`,
  `CREATE TRIGGER IF NOT EXISTS ar_ledger_no_update BEFORE UPDATE ON ar_ledger_entries BEGIN SELECT RAISE(ABORT, 'ar ledger entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ar_ledger_no_delete BEFORE DELETE ON ar_ledger_entries BEGIN SELECT RAISE(ABORT, 'ar ledger entries are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS integration_attempts_validate_insert BEFORE INSERT ON integration_delivery_attempts WHEN NEW.attempt_no<1 OR NEW.direction NOT IN ('INBOUND','OUTBOUND') OR NEW.status NOT IN ('ACKED','FAILED') BEGIN SELECT RAISE(ABORT, 'invalid integration attempt'); END`,
  `CREATE TRIGGER IF NOT EXISTS integration_attempts_no_update BEFORE UPDATE ON integration_delivery_attempts BEGIN SELECT RAISE(ABORT, 'integration attempts are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS integration_attempts_no_delete BEFORE DELETE ON integration_delivery_attempts BEGIN SELECT RAISE(ABORT, 'integration attempts are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS accounting_journal_lines_validate_insert BEFORE INSERT ON accounting_journal_lines WHEN NEW.debit<0 OR NEW.credit<0 OR (NEW.debit=0 AND NEW.credit=0) OR (NEW.debit>0 AND NEW.credit>0) OR NOT EXISTS (SELECT 1 FROM accounting_accounts WHERE id=NEW.account_id AND property_id=NEW.property_id AND active=1) BEGIN SELECT RAISE(ABORT, 'invalid accounting journal line'); END`,
  `CREATE TRIGGER IF NOT EXISTS accounting_journal_lines_no_update BEFORE UPDATE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT, 'accounting journal lines are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS accounting_journal_lines_no_delete BEFORE DELETE ON accounting_journal_lines BEGIN SELECT RAISE(ABORT, 'accounting journal lines are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS accounting_journal_entries_no_delete BEFORE DELETE ON accounting_journal_entries BEGIN SELECT RAISE(ABORT, 'accounting journal entries are immutable'); END`,
];

async function ready(db: D1) {
  if (!initialization) initialization = (db.dialect === "postgres" ? initializePostgres(db) : initialize(db)).catch(error => { initialization = null; throw error; });
  await initialization;
}

async function initializePostgres(db: D1) {
  for (const table of ["properties", "reservation_type_nights", "business_blocks", "folio_windows", "channel_connections", "report_exports", "channel_contracts", "accounting_accounts", "accounting_journal_entries"]) {
    await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first();
  }
  const property = await db.prepare("SELECT id FROM properties WHERE id='prop-seoul'").first();
  if (!property) throw new Error("Supabase PMS schema exists but the property seed is missing.");
  await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', 'frontdesk@aurora.hotel', 'PROPERTY_ADMIN', 1, ?)")
    .bind("role-local-admin", new Date().toISOString()).run();
}

async function initialize(db: D1) {
  let propertyExists = false;
  try { propertyExists = Boolean(await db.prepare("SELECT id FROM properties WHERE id='prop-seoul' LIMIT 1").first()); await db.prepare("SELECT id FROM reservation_type_nights LIMIT 1").first(); await db.prepare("SELECT id FROM business_blocks LIMIT 1").first(); await db.prepare("SELECT id FROM folio_windows LIMIT 1").first(); await db.prepare("SELECT id FROM channel_connections LIMIT 1").first(); }
  catch { await db.batch(schema.map((sql) => db.prepare(sql))); }
  const now = new Date().toISOString();
  await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', 'frontdesk@aurora.hotel', 'PROPERTY_ADMIN', 1, ?)").bind("role-local-admin", now).run();
  if (propertyExists) { await ensureReportingModel(db); await ensureInventoryTriggers(db,now); await ensureGroupTriggers(db,now); await ensureFinancialModel(db,now); await ensureIntegrationModel(db,now); await ensureExtendedModel(db,now); await backfillLegacyNights(db,now); return; }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO properties VALUES (?, ?, ?, ?, ?, ?)").bind("prop-seoul", "오로라 서울 호텔", "SEL01", "Asia/Seoul", "KRW", "2026-07-15"),
    db.prepare("INSERT OR IGNORE INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind("rt-dlx", "prop-seoul", "DLX", "디럭스 킹", 198000, 2, "킹 베드 기반의 대표 객실"),
    db.prepare("INSERT OR IGNORE INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind("rt-twn", "prop-seoul", "TWN", "프리미어 트윈", 228000, 3, "가족 및 비즈니스 고객용 트윈"),
    db.prepare("INSERT OR IGNORE INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind("rt-ste", "prop-seoul", "STE", "시티 스위트", 420000, 4, "거실과 침실이 분리된 스위트"),
  ]);
  const rooms = [["101","rt-dlx","CLEAN"],["102","rt-dlx","DIRTY"],["103","rt-twn","INSPECTED"],["201","rt-dlx","CLEAN"],["202","rt-twn","CLEAN"],["203","rt-twn","DIRTY"],["301","rt-ste","INSPECTED"],["302","rt-ste","OUT_OF_SERVICE"]];
  await db.batch(rooms.map(([n,t,h], i) => db.prepare("INSERT OR IGNORE INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)").bind(`room-${n}`, "prop-seoul", t, n, Number(n[0]), i === 3 ? "OCCUPIED" : "VACANT", h, JSON.stringify(i > 5 ? ["한강 전망","고층"] : ["금연"]))));
  const guests = [["g1","민준","김","GOLD"],["g2","Sofia","Martinez","NONE"],["g3","서연","박","PLATINUM"],["g4","David","Chen","SILVER"]];
  await db.batch(guests.map(([id,first,last,vip]) => db.prepare("INSERT OR IGNORE INTO guests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id,"prop-seoul",first,last,`${id}@example.com`,`010-20${id.charCodeAt(1)}-8800`,vip,"KR",JSON.stringify(vip !== "NONE" ? ["고층","조용한 객실"] : []),now)));
  const rs = [
    ["r1","SEL-260715-0184","g1","rt-dlx","room-101","DUE_IN",2,0,"Direct","BAR","14:00"],
    ["r2","SEL-260715-0191","g2","rt-twn","room-103","DUE_IN",2,1,"Booking.com","OTA","15:30"],
    ["r3","SEL-260714-0168","g3","rt-dlx","room-201","IN_HOUSE",1,0,"Corporate","CORP",""],
    ["r4","SEL-260715-0202","g4","rt-ste",null,"DUE_IN",2,0,"Expedia","OTA","17:00"],
  ];
  await db.batch(rs.map((r) => db.prepare("INSERT OR IGNORE INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(r[0],r[1],"prop-seoul",r[2],r[3],r[4],r[0]==="r3"?"2026-07-14":"2026-07-15",r[0]==="r3"?"2026-07-17":"2026-07-16",r[5],r[6],r[7],r[8],r[9],r[3]==="rt-ste"?420000:r[3]==="rt-twn"?228000:198000,r[10],r[0]==="r4"?"Late arrival · airport transfer":"",now,now)));
  const nightStatements: D1PreparedStatement[] = [];
  for (const r of rs) {
    const arrival = r[0] === "r3" ? "2026-07-14" : "2026-07-15"; const departure = r[0] === "r3" ? "2026-07-17" : "2026-07-16";
    for (const stayDate of datesBetween(arrival, departure)) {
      nightStatements.push(db.prepare("INSERT OR IGNORE INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(String(r[0]),String(r[3]),stayDate));
      if (r[4]) nightStatements.push(db.prepare("INSERT OR IGNORE INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(String(r[0]),String(r[4]),stayDate));
    }
  }
  if (nightStatements.length) await db.batch(nightStatements);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:group-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now),
  ]);
  await db.batch([
    db.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("fe1","prop-seoul","r3","CHARGE","ROOM","객실료",198000,null,"2026-07-14",now,"night-audit",null),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk102","prop-seoul","room-102","2026-07-15","IN_PROGRESS",1,"이지은","우선 정비",now),
    db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind("hk203","prop-seoul","room-203","2026-07-15","PENDING",2,null,"",now),
  ]);
  await ensureFinancialModel(db,now);
  await ensureIntegrationModel(db,now);
  await ensureReportingModel(db);
  await ensureExtendedModel(db,now);
}

async function ensureExtendedModel(db:D1,now:string){
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:extended-revenue-accounting-v1'").first();if(marker)return;
  const names=["channel_contracts","channel_rate_overrides","channel_settlements","accounting_accounts","accounting_journal_entries","accounting_journal_lines","channel_contract_connection_uq","channel_rate_mapping_date_uq","channel_settlement_reservation_uq","accounting_account_code_uq","accounting_journal_no_uq","accounting_journal_line_entry_idx","accounting_journal_lines_validate_insert","accounting_journal_lines_no_update","accounting_journal_lines_no_delete","accounting_journal_entries_no_delete"];
  const statements=schema.filter(sql=>names.some(name=>sql.includes(name))).map(sql=>db.prepare(sql));
  const accounts=[["1100","현금 및 예금","ASSET","CASH","FINANCE"],["1200","채널 미수금","ASSET","CHANNEL_RECEIVABLE","FINANCE"],["1300","매출채권","ASSET","ACCOUNTS_RECEIVABLE","FINANCE"],["2100","매입채무","LIABILITY","ACCOUNTS_PAYABLE","FINANCE"],["2200","채널 수수료 미지급금","LIABILITY","CHANNEL_COMMISSION_PAYABLE","FINANCE"],["2300","부가세 예수금","LIABILITY","TAX_PAYABLE","FINANCE"],["4100","객실 매출","REVENUE","ROOM_REVENUE","ROOMS"],["4200","기타 영업 매출","REVENUE","OTHER_REVENUE","OPERATIONS"],["5100","채널 유통 비용","EXPENSE","CHANNEL_DISTRIBUTION","SALES"],["5200","호텔 운영 비용","EXPENSE","OPERATING_EXPENSE","OPERATIONS"],["5990","조정 손익","EXPENSE","ADJUSTMENT","FINANCE"]];
  statements.push(...accounts.map(([code,name,type,category,department])=>db.prepare("INSERT OR IGNORE INTO accounting_accounts(id,property_id,code,name,account_type,category,department,active,version,created_at,updated_at) VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 1, 1, ?, ?)").bind(`acct-prop-seoul-${code}`,code,name,type,category,department,now,now)),db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:extended-revenue-accounting-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now));
  await db.batch(statements);
}

async function ensureReportingModel(db:D1) {
  const roomTypeColumns=await db.prepare("PRAGMA table_info(room_types)").all<{name:string}>();
  if(!roomTypeColumns.results.some(column=>column.name==="description")) await db.prepare("ALTER TABLE room_types ADD COLUMN description TEXT NOT NULL DEFAULT ''").run();
  if(!roomTypeColumns.results.some(column=>column.name==="active")) await db.prepare("ALTER TABLE room_types ADD COLUMN active INTEGER NOT NULL DEFAULT 1").run();
  if(!roomTypeColumns.results.some(column=>column.name==="version")) await db.prepare("ALTER TABLE room_types ADD COLUMN version INTEGER NOT NULL DEFAULT 1").run();
  const roomColumns=await db.prepare("PRAGMA table_info(rooms)").all<{name:string}>();
  if(!roomColumns.results.some(column=>column.name==="active")) await db.prepare("ALTER TABLE rooms ADD COLUMN active INTEGER NOT NULL DEFAULT 1").run();
  const statements=schema.filter(sql=>sql.includes("report_exports")||sql.includes("report_reservation_filter_idx")||sql.includes("report_folio_business_idx")||sql.includes("report_audit_created_idx"));
  for(const statement of statements) await db.prepare(statement).run();
  const capacitySql=schema.find(sql=>sql.includes("reservation_type_nights_capacity"));
  const blockSql=schema.filter(sql=>sql.includes("block_inventory_capacity_"));
  if(capacitySql){await db.prepare("DROP TRIGGER IF EXISTS reservation_type_nights_capacity").run();await db.prepare(capacitySql).run();}
  for(const name of ["block_inventory_capacity_insert","block_inventory_capacity_update"]) await db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  for(const statement of blockSql) await db.prepare(statement).run();
}

async function ensureInventoryTriggers(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:inventory-triggers-v1'").first(); if(marker) return;
  const triggerSql=schema.filter(sql=>sql.includes("reservation_type_nights_capacity")||sql.includes("inventory_controls_validate_"));
  await db.batch([...triggerSql.map(sql=>db.prepare(sql)),db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:inventory-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now)]);
}

async function ensureGroupTriggers(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:group-triggers-v1'").first(); if(marker) return;
  const capacitySql=schema.find(sql=>sql.includes("reservation_type_nights_capacity")); const groupSql=schema.filter(sql=>sql.includes("block_inventory_capacity_")||sql.includes("block_pickup_"));
  if(!capacitySql) throw new Error("inventory capacity trigger is unavailable");
  await db.batch([db.prepare("DROP TRIGGER IF EXISTS reservation_type_nights_capacity"),db.prepare(capacitySql),...groupSql.map(sql=>db.prepare(sql)),db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES ('system:group-triggers-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now)]);
}

async function ensureFinancialModel(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:financial-model-v1'").first(); if(marker) return;
  const triggers=schema.filter(sql=>sql.includes("folio_entries_validate_insert")||sql.includes("folio_entries_no_")||sql.includes("folio_details_")||sql.includes("ar_ledger_"));
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS folio_entries_validate_insert"),db.prepare("DROP TRIGGER IF EXISTS folio_entries_no_update"),db.prepare("DROP TRIGGER IF EXISTS folio_entries_no_delete"),
    ...triggers.map(sql=>db.prepare(sql)),
    db.prepare("INSERT OR IGNORE INTO transaction_codes VALUES ('tc-room','prop-seoul','ROOM','객실료','ROOM',0.10,0,1)"),
    db.prepare("INSERT OR IGNORE INTO transaction_codes VALUES ('tc-fnb','prop-seoul','FNB','식음료','FNB',0.10,0.10,1)"),
    db.prepare("INSERT OR IGNORE INTO transaction_codes VALUES ('tc-misc','prop-seoul','MISC','기타 매출','MISC',0.10,0,1)"),
    db.prepare("INSERT OR IGNORE INTO transaction_codes VALUES ('tc-payment','prop-seoul','PAYMENT','결제','PAYMENT',0,0,1)"),
    db.prepare("INSERT OR IGNORE INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,status,created_at,created_by) SELECT 'fw-'||id,property_id,id,1,'Guest Folio','GUEST','OPEN',?,'system' FROM reservations").bind(now),
    db.prepare("INSERT OR IGNORE INTO folio_entry_details(entry_id,property_id,reservation_id,folio_window_id,net_amount,tax_amount,service_amount,currency,created_at) SELECT f.id,f.property_id,f.reservation_id,'fw-'||f.reservation_id,f.amount,0,0,p.currency,f.created_at FROM folio_entries f JOIN properties p ON p.id=f.property_id"),
    db.prepare("INSERT INTO idempotency_keys VALUES ('system:financial-model-v1','prop-seoul','SYSTEM_BACKFILL','system',?)").bind(now),
  ]);
}

async function ensureIntegrationModel(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:integration-model-v1'").first();if(marker)return;
  const triggers=schema.filter(sql=>sql.includes("integration_attempts_"));
  await db.batch([...triggers.map(sql=>db.prepare(sql)),db.prepare("INSERT INTO idempotency_keys VALUES ('system:integration-model-v1','prop-seoul','SYSTEM_DDL','system',?)").bind(now)]);
}

async function backfillLegacyNights(db:D1, now:string) {
  const marker=await db.prepare("SELECT key FROM idempotency_keys WHERE key='system:inventory-night-backfill-v1'").first(); if(marker) return;
  await db.batch([
    db.prepare(`WITH RECURSIVE type_dates(property_id,reservation_id,room_type_id,stay_date,departure_date) AS (
      SELECT property_id,id,room_type_id,arrival_date,departure_date FROM reservations WHERE status NOT IN ('CANCELLED','NO_SHOW')
      UNION ALL SELECT property_id,reservation_id,room_type_id,date(stay_date,'+1 day'),departure_date FROM type_dates WHERE date(stay_date,'+1 day') < departure_date
    ) INSERT OR IGNORE INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) SELECT property_id,reservation_id,room_type_id,stay_date FROM type_dates WHERE stay_date < departure_date`),
    db.prepare(`WITH RECURSIVE room_dates(property_id,reservation_id,room_id,stay_date,departure_date) AS (
      SELECT property_id,id,room_id,arrival_date,departure_date FROM reservations WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      UNION ALL SELECT property_id,reservation_id,room_id,date(stay_date,'+1 day'),departure_date FROM room_dates WHERE date(stay_date,'+1 day') < departure_date
    ) INSERT OR IGNORE INTO reservation_nights(property_id,reservation_id,room_id,stay_date) SELECT property_id,reservation_id,room_id,stay_date FROM room_dates WHERE stay_date < departure_date`),
    db.prepare("INSERT INTO idempotency_keys VALUES ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',?)").bind(now),
  ]);
}

function decodedDisplayName(request: Request, email: string) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded || request.headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return email;
  try { return decodeURIComponent(encoded); } catch { return email; }
}

const principalCache = new Map<string,{expires:number;role:Role}>();

async function principalFor(request: Request, db: D1): Promise<Principal | null> {
  const url = new URL(request.url); let email = request.headers.get("oai-authenticated-user-email");
  if (!email && ["localhost", "127.0.0.1"].includes(url.hostname)) email = "frontdesk@aurora.hotel";
  if (!email) email = process.env.PMS_DEMO_USER_EMAIL?.trim() || null;
  if (!email) return null;
  const cached=principalCache.get(email),now=Date.now();
  if(cached&&cached.expires>now)return {email,displayName:decodedDisplayName(request,email),role:cached.role,capabilities:roleCapabilities[cached.role]};
  if(principalCache.size>500){for(const [key,item] of principalCache)if(item.expires<=now)principalCache.delete(key);if(principalCache.size>500)principalCache.clear();}
  let assignment = await db.prepare("SELECT role FROM role_assignments WHERE property_id='prop-seoul' AND email=? AND active=1").bind(email).first<{role: Role}>();
  if (!assignment && request.headers.get("oai-authenticated-user-email")) {
    const configured = await db.prepare("SELECT COUNT(*) count FROM role_assignments WHERE property_id='prop-seoul' AND active=1 AND email<>'frontdesk@aurora.hotel'").first<{count:number}>();
    const bootstrapRole: Role = Number(configured?.count ?? 0) === 0 ? "PROPERTY_ADMIN" : "VIEWER";
    await db.prepare("INSERT OR IGNORE INTO role_assignments VALUES (?, 'prop-seoul', ?, ?, 1, ?)").bind(crypto.randomUUID(), email, bootstrapRole, new Date().toISOString()).run();
    assignment = { role: bootstrapRole };
  }
  const role: Role = (assignment?.role as Role | undefined) ?? "VIEWER";
  principalCache.set(email,{expires:now+30_000,role});
  return { email, displayName: decodedDisplayName(request, email), role, capabilities: roleCapabilities[role] };
}

async function operationalControls(db: D1, businessDate: string, actor?: string) {
  const [arrivals, cashiers, oos, failed, openCashier, priorAudit, roomPostings] = await Promise.all([
    db.prepare("SELECT COUNT(*) count FROM reservations WHERE property_id='prop-seoul' AND arrival_date=? AND status='DUE_IN'").bind(businessDate).first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=? AND status='OPEN'").bind(businessDate).first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id='prop-seoul' AND housekeeping_status='OUT_OF_SERVICE'").first<{count:number}>(),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'").first<{count:number}>(),
    actor ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first() : null,
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=? LIMIT 1").bind(businessDate).first(),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate).first<{count:number}>(),
  ]);
  const blockers = [
    { code:"UNRESOLVED_ARRIVALS", label:"미처리 도착 예약", count:Number(arrivals?.count??0), blocking:true },
    { code:"OPEN_CASHIERS", label:"미마감 캐셔", count:Number(cashiers?.count??0), blocking:true },
    { code:"FAILED_INTERFACES", label:"인터페이스 전송 실패", count:Number(failed?.count??0), blocking:false },
    { code:"OUT_OF_SERVICE", label:"판매 중지 객실", count:Number(oos?.count??0), blocking:false },
  ];
  return { blockers, canClose: blockers.every(x=>!x.blocking||x.count===0) && !priorAudit, openCashier, priorAudit, pendingRoomPostings:Number(roomPostings?.count??0) };
}

function datesBetween(arrival: string, departure: string) {
  const start = new Date(`${arrival}T00:00:00Z`), end = new Date(`${departure}T00:00:00Z`); const dates: string[] = [];
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) return dates;
  for (let day = new Date(start); day < end && dates.length < 730; day.setUTCDate(day.getUTCDate()+1)) dates.push(day.toISOString().slice(0,10));
  return dates;
}

const roundMoney=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
function inclusiveComponents(total:number,taxRate:number,serviceRate:number) {
  const net=roundMoney(total/(1+taxRate+serviceRate)); const tax=roundMoney(net*taxRate); const service=roundMoney(total-net-tax);
  return {net,tax,service,total:roundMoney(total)};
}
async function folioWindowFor(db:D1,reservationId:string,code:string,explicit?:string) {
  if(explicit){const row=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND status='OPEN'").bind(explicit,reservationId).first<{id:string}>();if(row)return row.id;throw new Error("invalid folio window");}
  const routed=await db.prepare("SELECT w.id FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id WHERE rr.reservation_id=? AND rr.transaction_code=? AND rr.active=1 AND w.status='OPEN' LIMIT 1").bind(reservationId,code).first<{id:string}>(); if(routed)return routed.id;
  const base=await db.prepare("SELECT id FROM folio_windows WHERE reservation_id=? AND status='OPEN' ORDER BY window_no LIMIT 1").bind(reservationId).first<{id:string}>(); if(!base)throw new Error("invalid folio window"); return base.id;
}

type ChannelPayload={connectionId:string;messageId:string;eventType:string;externalReservationId:string;revision:number;externalRoomTypeId?:string;externalRatePlanId?:string;firstName?:string;lastName?:string;email?:string;arrivalDate?:string;departureDate?:string;adults?:number;children?:number;nightlyRate?:number;currency?:string};
async function processChannelMessage(db:D1,message:Record<string,unknown>,payload:ChannelPayload,actor:string,now:string) {
  const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND status='ACTIVE'").bind(payload.connectionId).first<Record<string,unknown>>();if(!connection)throw new Error("channel connection unavailable");
  const link=await db.prepare("SELECT * FROM channel_reservation_links WHERE connection_id=? AND external_reservation_id=?").bind(payload.connectionId,payload.externalReservationId).first<Record<string,unknown>>();
  const revision=Number(payload.revision),attemptNo=Number(message.attempts??0)+1,eventType=payload.eventType.toUpperCase();if(!Number.isInteger(revision)||revision<1)throw new Error("invalid channel revision");if(link&&revision<=Number(link.last_revision))throw new Error("stale channel revision");
  const statements:D1PreparedStatement[]=[];let reservationId=String(link?.reservation_id??"");
  if(eventType==="NEW"){
    if(link)throw new Error("channel reservation already linked");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND active=1").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping)throw new Error("channel mapping unavailable");
    if(!payload.firstName?.trim()||!payload.lastName?.trim()||!payload.arrivalDate||!payload.departureDate)throw new Error("invalid channel reservation");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);
    const guestId=crypto.randomUUID();reservationId=crypto.randomUUID();const confirmation=`OTA-${String(connection.provider).slice(0,3).toUpperCase()}-${Math.floor(100000+Math.random()*900000)}`,nightlyRate=Number(payload.nightlyRate);if(!(nightlyRate>=0))throw new Error("invalid channel reservation");
    statements.push(db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, NULL, 'NONE', NULL, '[]', ?)").bind(guestId,payload.firstName.trim(),payload.lastName.trim(),payload.email||null,now));
    statements.push(db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||1,Number(payload.children)||0,String(connection.provider),String(mapping.rate_plan),nightlyRate,`Channel ${payload.externalReservationId} · revision ${revision}`,now,now));
    statements.push(db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("INSERT INTO channel_reservation_links VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'ACTIVE', ?, ?)").bind(crypto.randomUUID(),payload.connectionId,payload.externalReservationId,reservationId,revision,now,now));
  } else if(eventType==="MODIFY"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND status='DUE_IN'").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be modified");const mapping=await db.prepare("SELECT * FROM channel_mappings WHERE connection_id=? AND external_room_type_id=? AND external_rate_plan_id=? AND active=1").bind(payload.connectionId,payload.externalRoomTypeId,payload.externalRatePlanId).first<Record<string,unknown>>();if(!mapping||!payload.arrivalDate||!payload.departureDate)throw new Error("channel mapping unavailable");const controlError=await stayControlError(db,String(mapping.room_type_id),payload.arrivalDate,payload.departureDate);if(controlError)throw new Error(controlError);reservationId=String(link.reservation_id);
    statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'CHANNEL_MODIFY', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(reservationId));
    for(const stayDate of datesBetween(payload.arrivalDate,payload.departureDate))statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,mapping.room_type_id,stayDate));
    statements.push(db.prepare("UPDATE reservations SET room_type_id=?,room_id=NULL,arrival_date=?,departure_date=?,adults=?,children=?,nightly_rate=?,notes=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(mapping.room_type_id,payload.arrivalDate,payload.departureDate,Number(payload.adults)||Number(reservation.adults),Number(payload.children)||0,Number(payload.nightlyRate)||Number(reservation.nightly_rate),`Channel ${payload.externalReservationId} · revision ${revision}`,now,reservationId,Number(reservation.version)));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,updated_at=? WHERE id=?").bind(revision,now,link.id));
  } else if(eventType==="CANCEL"){
    if(!link||link.status!=="ACTIVE")throw new Error("channel reservation link unavailable");const reservation=await db.prepare("SELECT * FROM reservations WHERE id=? AND status NOT IN ('CANCELLED','CHECKED_OUT')").bind(link.reservation_id).first<Record<string,unknown>>();if(!reservation)throw new Error("channel reservation cannot be cancelled");reservationId=String(link.reservation_id);statements.push(db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'CHANNEL_CANCEL', ?, ?)").bind(crypto.randomUUID(),reservationId,Number(reservation.version),actor,now));statements.push(db.prepare("UPDATE reservations SET status='CANCELLED',version=version+1,updated_at=? WHERE id=? AND version=?").bind(now,reservationId,Number(reservation.version)));statements.push(db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(reservationId));statements.push(db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(reservationId));statements.push(db.prepare("UPDATE channel_reservation_links SET last_revision=?,status='CANCELLED',updated_at=? WHERE id=?").bind(revision,now,link.id));
  } else throw new Error("unsupported channel event");
  statements.push(db.prepare("UPDATE inbound_channel_messages SET status='PROCESSED',attempts=?,reservation_id=?,last_error=NULL,processed_at=? WHERE id=?").bind(attemptNo,reservationId,now,message.id));statements.push(db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, ?, 'ACKED', 200, NULL, NULL, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,message.id,attemptNo,JSON.stringify(payload),now,actor));statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, ?, 'channel_reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,`CHANNEL_${eventType}`,reservationId,JSON.stringify({externalReservationId:payload.externalReservationId,revision,messageId:payload.messageId}),now));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', ?, 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),`channel.reservation_${eventType.toLowerCase()}`,reservationId,JSON.stringify({reservationId,externalReservationId:payload.externalReservationId,revision}),now));await db.batch(statements);return reservationId;
}

async function stayControlError(db:D1, roomTypeId:string, arrival:string, departure:string) {
  const nights=datesBetween(arrival,departure); if (!nights.length) return "올바른 숙박 일정을 입력하세요.";
  const controls=await db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date BETWEEN ? AND ?").bind(roomTypeId,arrival,departure).all<Record<string,unknown>>();
  const arrivalControl=controls.results.find(row=>row.stay_date===arrival), departureControl=controls.results.find(row=>row.stay_date===departure);
  if (arrivalControl?.close_to_arrival) return "선택한 도착일은 체크인 제한(CTA)이 설정되어 있습니다.";
  if (departureControl?.close_to_departure) return "선택한 출발일은 체크아웃 제한(CTD)이 설정되어 있습니다.";
  const minimum=Math.max(1,...controls.results.filter(row=>nights.includes(String(row.stay_date))).map(row=>Number(row.min_stay??1)));
  if (nights.length<minimum) return `최소 ${minimum}박 이상 예약해야 합니다.`;
  return null;
}

async function snapshot(db: D1, principal?: Principal | null) {
  const [propertyResult,reservationResult,roomResult,actorCashierResult,openCashierResult,failedResult,auditResult,postingsResult,roomTypesResult,typeNightsResult,inventoryControlsResult,accountProfilesResult,blocksResult,blockInventoryResult,roomingResult,folioWindowsResult,folioEntriesResult,routingRulesResult,transactionCodesResult,arAccountsResult,arInvoicesResult,trialBalanceResult,channelConnectionsResult,channelContractsResult,channelMappingsResult,ariUpdatesResult,inboundMessagesResult,channelLinksResult,integrationAttemptsResult,outboxResult] = await db.batch([
    db.prepare("SELECT * FROM properties WHERE id='prop-seoul' LIMIT 1"),
    db.prepare(`SELECT r.*, g.first_name, g.last_name, g.vip_level, rm.number room_number, rt.code room_type_code, rt.name room_type_name, COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types rt ON rt.id=r.room_type_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN folio_entries f ON f.reservation_id=r.id WHERE r.property_id='prop-seoul' GROUP BY r.id,g.id,rt.id,rm.id ORDER BY CASE r.status WHEN 'DUE_IN' THEN 1 WHEN 'IN_HOUSE' THEN 2 ELSE 3 END, r.eta`),
    db.prepare(`SELECT rm.*, rt.code room_type_code, rt.name room_type_name, h.status task_status, h.assignee FROM rooms rm JOIN room_types rt ON rt.id=rm.room_type_id LEFT JOIN housekeeping_tasks h ON h.room_id=rm.id AND h.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') WHERE rm.property_id='prop-seoul' ORDER BY rm.number`),
    principal ? db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(principal.email) : db.prepare("SELECT * FROM cashier_sessions WHERE 0"),
    db.prepare("SELECT COUNT(*) count FROM cashier_sessions WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND status='OPEN'"),
    db.prepare("SELECT COUNT(*) count FROM outbox_events WHERE property_id='prop-seoul' AND status='FAILED'"),
    db.prepare("SELECT * FROM night_audits WHERE property_id='prop-seoul' AND business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') LIMIT 1"),
    db.prepare("SELECT COUNT(*) count FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=(SELECT business_date FROM properties WHERE id='prop-seoul') AND r.departure_date>(SELECT business_date FROM properties WHERE id='prop-seoul') AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=(SELECT business_date FROM properties WHERE id='prop-seoul') AND f.kind='CHARGE' AND f.code='ROOM')"),
    db.prepare("SELECT * FROM room_types WHERE property_id='prop-seoul' ORDER BY code"),
    db.prepare("SELECT room_type_id, stay_date, COUNT(*) booked FROM reservation_type_nights WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day') GROUP BY room_type_id, stay_date"),
    db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND stay_date BETWEEN (SELECT business_date FROM properties WHERE id='prop-seoul') AND date((SELECT business_date FROM properties WHERE id='prop-seoul'), '+13 day')"),
    db.prepare("SELECT * FROM account_profiles WHERE property_id='prop-seoul' AND active=1 ORDER BY type,name"),
    db.prepare("SELECT bb.*,ap.name account_name,gp.name group_name,COALESCE(SUM(bi.original_rooms),0) original_room_nights,COALESCE(SUM(bi.current_rooms),0) current_room_nights,COALESCE(SUM(bi.picked_up),0) picked_up_room_nights FROM business_blocks bb LEFT JOIN account_profiles ap ON ap.id=bb.account_profile_id LEFT JOIN account_profiles gp ON gp.id=bb.group_profile_id LEFT JOIN block_inventory bi ON bi.block_id=bb.id WHERE bb.property_id='prop-seoul' GROUP BY bb.id,ap.id,gp.id ORDER BY bb.arrival_date,bb.code"),
    db.prepare("SELECT bi.*,rt.code room_type_code,rt.name room_type_name FROM block_inventory bi JOIN room_types rt ON rt.id=bi.room_type_id WHERE bi.property_id='prop-seoul' ORDER BY bi.block_id,bi.stay_date,rt.code"),
    db.prepare("SELECT rl.*,rt.code room_type_code,rt.name room_type_name FROM rooming_list_entries rl JOIN room_types rt ON rt.id=rl.room_type_id WHERE rl.property_id='prop-seoul' ORDER BY rl.block_id,rl.last_name,rl.first_name"),
    db.prepare(`SELECT w.*,g.first_name||' '||g.last_name guest_name,r.confirmation_no,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id JOIN guests g ON g.id=r.guest_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id LEFT JOIN folio_entries f ON f.id=d.entry_id WHERE w.property_id='prop-seoul' GROUP BY w.id,r.id,g.id ORDER BY r.updated_at DESC,w.window_no`),
    db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,d.currency,d.source_entry_id,d.reason,w.window_no,w.name window_name,r.confirmation_no,g.first_name||' '||g.last_name guest_name FROM folio_entries f LEFT JOIN folio_entry_details d ON d.entry_id=f.id LEFT JOIN folio_windows w ON w.id=d.folio_window_id JOIN reservations r ON r.id=f.reservation_id JOIN guests g ON g.id=r.guest_id WHERE f.property_id='prop-seoul' ORDER BY f.created_at DESC LIMIT 250"),
    db.prepare("SELECT rr.*,w.window_no,w.name window_name,r.confirmation_no FROM folio_routing_rules rr JOIN folio_windows w ON w.id=rr.target_window_id JOIN reservations r ON r.id=rr.reservation_id WHERE rr.property_id='prop-seoul' AND rr.active=1 ORDER BY rr.created_at DESC"),
    db.prepare("SELECT * FROM transaction_codes WHERE property_id='prop-seoul' AND active=1 ORDER BY category,code"),
    db.prepare("SELECT a.*,p.name profile_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_accounts a JOIN account_profiles p ON p.id=a.account_profile_id LEFT JOIN ar_ledger_entries l ON l.ar_account_id=a.id WHERE a.property_id='prop-seoul' GROUP BY a.id,p.id ORDER BY a.account_no"),
    db.prepare("SELECT i.*,a.account_no,a.name account_name,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i JOIN ar_accounts a ON a.id=i.ar_account_id LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id WHERE i.property_id='prop-seoul' GROUP BY i.id,a.id ORDER BY i.issued_date DESC,i.invoice_no DESC"),
    db.prepare(`SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) guest_ledger,(SELECT COALESCE(SUM(debit-credit),0) FROM ar_ledger_entries WHERE property_id='prop-seoul') ar_ledger,COALESCE(SUM(CASE WHEN kind='CHARGE' THEN amount WHEN kind='CHARGE_REVERSAL' THEN -amount ELSE 0 END),0) gross_revenue,COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='PAYMENT_REVERSAL' THEN -amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0) net_payments FROM folio_entries WHERE property_id='prop-seoul'`),
    db.prepare("SELECT * FROM channel_connections WHERE property_id='prop-seoul' ORDER BY provider,name"),
    db.prepare("SELECT cc.*,c.provider,c.name connection_name FROM channel_contracts cc JOIN channel_connections c ON c.id=cc.connection_id WHERE cc.property_id='prop-seoul' ORDER BY c.provider,c.name"),
    db.prepare("SELECT m.*,c.provider,c.name connection_name,rt.code room_type_code,rt.name room_type_name FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id JOIN room_types rt ON rt.id=m.room_type_id WHERE m.property_id='prop-seoul' ORDER BY c.provider,rt.code,m.rate_plan"),
    db.prepare("SELECT a.*,c.provider,m.external_room_type_id,m.external_rate_plan_id,rt.code room_type_code FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id JOIN channel_mappings m ON m.id=a.mapping_id JOIN room_types rt ON rt.id=m.room_type_id WHERE a.property_id='prop-seoul' ORDER BY a.created_at DESC LIMIT 150"),
    db.prepare("SELECT i.*,c.name connection_name FROM inbound_channel_messages i JOIN channel_connections c ON c.id=i.connection_id WHERE i.property_id='prop-seoul' ORDER BY i.received_at DESC LIMIT 150"),
    db.prepare("SELECT l.*,c.provider,r.confirmation_no FROM channel_reservation_links l JOIN channel_connections c ON c.id=l.connection_id JOIN reservations r ON r.id=l.reservation_id WHERE l.property_id='prop-seoul' ORDER BY l.updated_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM integration_delivery_attempts WHERE property_id='prop-seoul' ORDER BY created_at DESC LIMIT 150"),
    db.prepare("SELECT * FROM outbox_events WHERE property_id='prop-seoul' ORDER BY created_at DESC LIMIT 150"),
  ]);
  const property = propertyResult.results[0] as Record<string,unknown>; const reservations=reservationResult.results as Array<Record<string,unknown>>; const rooms=roomResult.results as Array<Record<string,unknown>>;
  const activeRooms=rooms.filter(x=>Number(x.active??1)===1); const metrics = { rooms:activeRooms.length, occupied:activeRooms.filter(x=>x.front_desk_status==='OCCUPIED').length, dirty:activeRooms.filter(x=>x.housekeeping_status==='DIRTY').length, ready:activeRooms.filter(x=>x.housekeeping_status==='CLEAN'||x.housekeeping_status==='INSPECTED').length };
  const arrivals=reservations.filter(x=>x.arrival_date===property.business_date&&x.status==='DUE_IN').length, cashiers=Number((openCashierResult.results[0] as {count?:number})?.count??0), failed=Number((failedResult.results[0] as {count?:number})?.count??0), oos=rooms.filter(x=>x.housekeeping_status==='OUT_OF_SERVICE').length;
  const blockers = [
    { code:"UNRESOLVED_ARRIVALS", label:"미처리 도착 예약", count:arrivals, blocking:true },
    { code:"OPEN_CASHIERS", label:"미마감 캐셔", count:cashiers, blocking:true },
    { code:"FAILED_INTERFACES", label:"인터페이스 전송 실패", count:failed, blocking:false },
    { code:"OUT_OF_SERVICE", label:"판매 중지 객실", count:oos, blocking:false },
  ];
  const priorAudit=auditResult.results[0]??null; const controls={blockers,canClose:blockers.every(x=>!x.blocking||x.count===0)&&!priorAudit,openCashier:actorCashierResult.results[0]??null,priorAudit,pendingRoomPostings:Number((postingsResult.results[0] as {count?:number})?.count??0)};
  const dates=Array.from({length:14},(_,index)=>{const day=new Date(`${String(property.business_date)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()+index);return day.toISOString().slice(0,10)});
  const typeNights=typeNightsResult.results as Array<Record<string,unknown>>, controlRows=inventoryControlsResult.results as Array<Record<string,unknown>>, roomTypes=roomTypesResult.results as Array<Record<string,unknown>>;
  const booked=new Map(typeNights.map(row=>[`${row.room_type_id}:${row.stay_date}`,Number(row.booked)])); const inventoryControls=new Map(controlRows.map(row=>[`${row.room_type_id}:${row.stay_date}`,row]));
  const inventory={dates,types:roomTypes.map(type=>{const physical=rooms.filter(room=>room.room_type_id===type.id&&Number(room.active??1)===1&&room.housekeeping_status!=="OUT_OF_SERVICE").length;return {...type,physical,cells:dates.map(stayDate=>{const control=inventoryControls.get(`${type.id}:${stayDate}`);const sellLimit=control?.sell_limit==null?physical:Number(control.sell_limit),reserved=booked.get(`${type.id}:${stayDate}`)??0,closed=Boolean(control?.closed);return {stayDate,sellLimit,reserved,available:closed?0:Math.max(0,sellLimit-reserved),closed,minStay:Number(control?.min_stay??1),cta:Boolean(control?.close_to_arrival),ctd:Boolean(control?.close_to_departure),price:Number(control?.price_override??type.base_rate)};})}})};
  const groups={accounts:accountProfilesResult.results,blocks:blocksResult.results,inventory:blockInventoryResult.results,rooming:roomingResult.results};
  const finance={windows:folioWindowsResult.results,entries:folioEntriesResult.results,routing:routingRulesResult.results,transactionCodes:transactionCodesResult.results,arAccounts:arAccountsResult.results,arInvoices:arInvoicesResult.results,trialBalance:trialBalanceResult.results[0]??{guest_ledger:0,ar_ledger:0,gross_revenue:0,net_payments:0}};
  const integrations={connections:channelConnectionsResult.results,contracts:channelContractsResult.results,mappings:channelMappingsResult.results,ari:ariUpdatesResult.results,inbound:inboundMessagesResult.results,links:channelLinksResult.results,attempts:integrationAttemptsResult.results,outbox:outboxResult.results};
  return { property, reservations, rooms, metrics, principal, controls, inventory, groups, finance, integrations };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const snapshotCache = new Map<string,{expires:number,value:Promise<Snapshot>}>();
const snapshotRepresentationCache = new Map<string,{expires:number,json:Promise<string>,gzip:Promise<ArrayBuffer>}>();
type ReportResult=Awaited<ReturnType<typeof runReport>>;
const reportCache=new Map<string,{expires:number;value:Promise<ReportResult>}>();
function invalidateSnapshots() { snapshotCache.clear(); snapshotRepresentationCache.clear(); reportCache.clear(); }
async function cachedSnapshot(db:D1, principal:Principal) {
  const key=principal.email; const cached=snapshotCache.get(key); const now=Date.now();
  if (cached && cached.expires>now) return cached.value;
  const value=snapshot(db,principal); snapshotCache.set(key,{expires:now+3000,value});
  try { return await value; } catch (error) { snapshotCache.delete(key); throw error; }
}
async function gzipSnapshot(json: Promise<string>) {
  const stream = new Blob([await json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
async function cachedSnapshotResponse(db:D1,principal:Principal,request:Request) {
  const key=principal.email,now=Date.now();let cached=snapshotRepresentationCache.get(key);
  if(!cached||cached.expires<=now){const json=cachedSnapshot(db,principal).then(value=>JSON.stringify(value));cached={expires:now+3000,json,gzip:gzipSnapshot(json)};snapshotRepresentationCache.set(key,cached);}
  const common={"Cache-Control":"private, no-store","Content-Type":"application/json; charset=utf-8","Vary":"Accept-Encoding"};
  if(/(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get("accept-encoding")||""))return new Response(await cached.gzip,{headers:{...common,"Content-Encoding":"gzip"}});
  return new Response(await cached.json,{headers:common});
}
async function cachedReport(db:D1,params:URLSearchParams,principal:Principal){const key=`${principal.email}:${params.toString()}`,now=Date.now(),cached=reportCache.get(key);if(cached&&cached.expires>now)return cached.value;if(reportCache.size>200){for(const [cacheKey,item] of reportCache)if(item.expires<=now)reportCache.delete(cacheKey);if(reportCache.size>200)reportCache.clear();}const value=runReport(db,params,principal);reportCache.set(key,{expires:now+5000,value});try{return await value;}catch(error){reportCache.delete(key);throw error;}}

export async function GET(request: Request) {
  const db = getPmsDatabase(runtimeBindings);
  await ready(db); const principal = await principalFor(request, db);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  const url=new URL(request.url);
  if(url.searchParams.get("view")==="inventory") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
      return Response.json(await loadInventoryCalendar(db,from,to),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="accounting") {
    try {
      const property=await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(),from=url.searchParams.get("from")||String(property?.business_date),to=url.searchParams.get("to")||String(property?.business_date);
      return Response.json(await loadAccountingCenter(db,from,to),{headers:{"Cache-Control":"private, no-store"}});
    } catch(error){if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if(url.searchParams.get("view")==="report") {
    try { return Response.json(await cachedReport(db,url.searchParams,principal),{headers:{"Cache-Control":"private, no-store"}}); }
    catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  return cachedSnapshotResponse(db,principal,request);
}

export async function POST(request: Request) {
  const db = getPmsDatabase(runtimeBindings);
  await ready(db); const principal = await principalFor(request, db);
  if (!principal) return Response.json({error:"로그인이 필요합니다."},{status:401});
  let body: Record<string, string>;
  try { body = await request.json() as Record<string, string>; }
  catch { return Response.json({error:"요청 본문이 올바른 JSON이 아닙니다."},{status:400}); }
  const now = new Date().toISOString(); const actor = principal.email;
  const requiredCapability = actionCapability[body.action];
  if (!requiredCapability || !principal.capabilities.includes(requiredCapability)) return Response.json({error:"이 작업을 수행할 권한이 없습니다."},{status:403});
  const idempotencyKey = request.headers.get("idempotency-key");
  if(body.action==="export_report") {
    try {
      const params=new URLSearchParams();for(const key of ["report","q","from","to","status","source","roomTypeId"]){if(body[key])params.set(key,body[key]);}
      const report=await runReport(db,params,principal,{exportMode:true});
      if(report.pagination.total>report.export.maxRows)return Response.json({error:`결과가 ${report.export.maxRows.toLocaleString()}행을 초과합니다. 기간 또는 필터를 좁혀 주세요.`},{status:413});
      const exportId=crypto.randomUUID(),filters=JSON.stringify(report.filters),format=body.format==="CSV"?"CSV":"XLSX";
      await db.batch([
        db.prepare("INSERT INTO report_exports VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)").bind(exportId,report.report.key,format,filters,report.rows.length,actor,now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'EXPORT_REPORT', 'report_export', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,exportId,JSON.stringify({report:report.report.key,filters,rowCount:report.rows.length,format}),now),
        ...(idempotencyKey?[db.prepare("INSERT OR IGNORE INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[]),
      ]);
      invalidateSnapshots();
      return Response.json({...report,exportId});
    } catch(error){if(error instanceof ReportRequestError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  if (idempotencyKey) {
    const duplicate = await db.prepare("SELECT key FROM idempotency_keys WHERE key=?").bind(idempotencyKey).first();
    if (duplicate) return Response.json(await cachedSnapshot(db, principal), {headers:{"X-Idempotent-Replay":"true"}});
  }
  const reservation = body.reservationId ? await db.prepare("SELECT * FROM reservations WHERE id=?").bind(body.reservationId).first<Record<string, unknown>>() : null;
  const propertyState = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(propertyState?.business_date);
  try {
    if(await handleExtendedAction(db,body,principal,businessDate,now,idempotencyKey)) {
      // Extended revenue, inventory and accounting actions are committed by the
      // specialized service and share the same snapshot response contract.
    } else if(body.action==="create_room_type") {
      const code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300);
      if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"타입 코드는 영문·숫자 2~12자, 이름은 2~80자, 기준 인원은 1~20명으로 입력하세요."},{status:400});
      const typeId=crypto.randomUUID();await db.batch([
        db.prepare("INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active) VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 1)").bind(typeId,code,name,baseRate,capacity,description),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ROOM_TYPE', 'room_type', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,typeId,JSON.stringify({code,name,baseRate,capacity,description,active:true}),now),
        ...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[]),
      ]);
    } else if(body.action==="update_room_type") {
      const current=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(),code=(body.code||"").trim().toUpperCase(),name=(body.name||"").trim(),baseRate=Number(body.baseRate),capacity=Number(body.capacity),description=(body.description||"").trim().slice(0,300),active=body.active!=="false";
      if(!current)return Response.json({error:"객실 타입을 찾지 못했습니다."},{status:404});if(!/^[A-Z0-9_-]{2,12}$/.test(code)||name.length<2||name.length>80||!Number.isFinite(baseRate)||baseRate<0||!Number.isInteger(capacity)||capacity<1||capacity>20)return Response.json({error:"객실 타입 입력값을 확인하세요."},{status:400});
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실 타입을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      if(!active){const future=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE room_type_id=? AND stay_date>=?").bind(body.roomTypeId,businessDate).first<{count:number}>();if(Number(future?.count||0)>0)return Response.json({error:"미래 예약이 있는 객실 타입은 비활성화할 수 없습니다."},{status:409});}
      await db.batch([db.prepare("UPDATE room_types SET code=?,name=?,base_rate=?,capacity=?,description=?,active=?,version=version+1 WHERE id=? AND version=?").bind(code,name,baseRate,capacity,description,active?1:0,body.roomTypeId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_ROOM_TYPE', 'room_type', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomTypeId,JSON.stringify(current),JSON.stringify({code,name,baseRate,capacity,description,active,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="create_room") {
      const number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"활성 객실 타입, 16자 이하 객실번호, -10~250층을 입력하세요."},{status:400});const roomId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, 'prop-seoul', ?, ?, ?, 'VACANT', 'CLEAN', ?, 1, 1)").bind(roomId,body.roomTypeId,number,floor,JSON.stringify(features)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ROOM', 'room', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,roomId,JSON.stringify({number,floor,roomTypeId:body.roomTypeId,features}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="bulk_create_rooms") {
      const start=Number(body.startNumber),count=Number(body.count),floor=Number(body.floor),padding=Math.min(8,Math.max(1,Number(body.padding)||String(body.startNumber||"").length)),prefix=(body.prefix||"").trim().toUpperCase().slice(0,8),type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!type||!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>500||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"시작 번호와 생성 수량(1~500), 층, 활성 객실 타입을 확인하세요."},{status:400});
      const numbers=Array.from({length:count},(_,index)=>`${prefix}${String(start+index).padStart(padding,"0")}`);if(numbers.some(number=>number.length>16))return Response.json({error:"생성되는 객실번호는 16자를 초과할 수 없습니다."},{status:400});const existing=await db.prepare("SELECT number FROM rooms WHERE property_id='prop-seoul'").all<{number:string}>(),known=new Set(existing.results.map(row=>row.number));const duplicate=numbers.find(number=>known.has(number));if(duplicate)return Response.json({error:`객실 ${duplicate}번이 이미 존재합니다.`},{status:409});
      const created:string[]=[];for(let offset=0;offset<numbers.length;offset+=40){const slice=numbers.slice(offset,offset+40),statements=slice.map(number=>{const roomId=crypto.randomUUID();created.push(roomId);return db.prepare("INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,active,version) VALUES (?, 'prop-seoul', ?, ?, ?, 'VACANT', 'CLEAN', ?, 1, 1)").bind(roomId,body.roomTypeId,number,floor,JSON.stringify(features));});await db.batch(statements);}
      await db.batch([db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'BULK_CREATE_ROOMS', 'room_batch', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,crypto.randomUUID(),JSON.stringify({roomTypeId:body.roomTypeId,prefix,start,count,floor,numbers}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if(body.action==="update_room") {
      const current=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul'").bind(body.roomId).first<Record<string,unknown>>(),number=(body.number||"").trim().toUpperCase(),floor=Number(body.floor),active=body.active!=="false",type=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first(),features=(body.features||"").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20);
      if(!current)return Response.json({error:"객실을 찾지 못했습니다."},{status:404});if(!type||!number||number.length>16||!Number.isInteger(floor)||floor< -10||floor>250)return Response.json({error:"객실 입력값을 확인하세요."},{status:400});const changingType=String(current.room_type_id)!==body.roomTypeId,future=await db.prepare("SELECT COUNT(*) count FROM reservation_nights WHERE room_id=? AND stay_date>=?").bind(body.roomId,businessDate).first<{count:number}>();if((changingType||!active)&&Number(future?.count||0)>0)return Response.json({error:"미래 예약이 배정된 객실은 타입 변경 또는 비활성화할 수 없습니다."},{status:409});if(!active&&current.front_desk_status==="OCCUPIED")return Response.json({error:"투숙 중인 객실은 비활성화할 수 없습니다."},{status:409});const housekeeping=active?(current.housekeeping_status==="OUT_OF_SERVICE"?"CLEAN":String(current.housekeeping_status)):"OUT_OF_SERVICE";
      if(Number(body.expectedVersion)!==Number(current.version))return Response.json({error:"다른 사용자가 객실을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도하세요."},{status:409});
      await db.batch([db.prepare("UPDATE rooms SET room_type_id=?,number=?,floor=?,features=?,active=?,housekeeping_status=?,version=version+1 WHERE id=? AND version=?").bind(body.roomTypeId,number,floor,JSON.stringify(features),active?1:0,housekeeping,body.roomId,Number(current.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_ROOM', 'room', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.roomId,JSON.stringify(current),JSON.stringify({roomTypeId:body.roomTypeId,number,floor,features,active,housekeeping,version:Number(current.version)+1}),now),...(idempotencyKey?[db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)]:[])]);
    } else if (body.action === "create_reservation") {
      const arrival = new Date(`${body.arrivalDate}T00:00:00Z`), departure = new Date(`${body.departureDate}T00:00:00Z`);
      if (!body.firstName?.trim() || !body.lastName?.trim() || !Number.isFinite(arrival.valueOf()) || departure <= arrival) return Response.json({error:"고객명과 올바른 숙박 일정을 입력하세요."},{status:400});
      const type = await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first<Record<string,unknown>>();
      if (!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const room = body.roomId ? await db.prepare("SELECT * FROM rooms WHERE id=? AND room_type_id=? AND active=1").bind(body.roomId,body.roomTypeId).first<Record<string,unknown>>() : null;
      if (body.roomId && !room) return Response.json({error:"선택한 객실과 객실 타입이 일치하지 않습니다."},{status:409});
      const guestId=crypto.randomUUID(), reservationId=crypto.randomUUID(), confirmation=`SEL-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`;
      const statements = [
        db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', ?, '[]', ?)").bind(guestId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.nationality||"KR",now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, ?, ?, ?, 'DUE_IN', ?, ?, ?, ?, ?, ?, '', 1, ?, ?)").bind(reservationId,confirmation,guestId,body.roomTypeId,body.roomId||null,body.arrivalDate,body.departureDate,Number(body.adults)||1,Number(body.children)||0,body.source||"Direct",body.ratePlan||"BAR",Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for (const stayDate of datesBetween(body.arrivalDate,body.departureDate)) {
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomTypeId,stayDate));
        if (body.roomId) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,body.roomId,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_RESERVATION', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,reservationId,JSON.stringify({confirmation,status:"DUE_IN"}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.created', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),reservationId,JSON.stringify({reservationId,confirmation}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "edit_reservation" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 수정할 수 있습니다."},{status:409});
      if(await db.prepare("SELECT id FROM rooming_list_entries WHERE reservation_id=?").bind(body.reservationId).first()) return Response.json({error:"그룹 픽업 예약은 블록 rooming list에서 수정하세요."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const type=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!type) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!stayDates.length) return Response.json({error:"올바른 숙박 일정을 입력하세요."},{status:400});
      const controlError=await stayControlError(db,body.roomTypeId,body.arrivalDate,body.departureDate); if(controlError) return Response.json({error:controlError},{status:409});
      const retainedRoom=reservation.room_id && reservation.room_type_id===body.roomTypeId ? String(reservation.room_id) : null;
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'EDIT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_type_id=?, room_id=?, arrival_date=?, departure_date=?, adults=?, children=?, rate_plan=?, nightly_rate=?, eta=?, notes=?, version=version+1, updated_at=? WHERE id=? AND status='DUE_IN' AND version=?").bind(body.roomTypeId,retainedRoom,body.arrivalDate,body.departureDate,Math.max(1,Number(body.adults)||1),Math.max(0,Number(body.children)||0),body.ratePlan||String(reservation.rate_plan),Number(body.nightlyRate)||Number(type.base_rate),body.eta||null,body.notes||"",now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of stayDates){
        statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomTypeId,stayDate));
        if(retainedRoom) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,retainedRoom,stayDate));
      }
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'EDIT_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({roomTypeId:body.roomTypeId,arrivalDate:body.arrivalDate,departureDate:body.departureDate,roomId:retainedRoom}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.updated', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,version:expectedVersion+1}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "assign_room" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약에만 객실을 배정할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.room_type_id!==reservation.room_type_id) return Response.json({error:"예약 객실 타입과 배정 객실 타입이 일치하지 않습니다."},{status:409});
      if(room.housekeeping_status==="OUT_OF_SERVICE") return Response.json({error:"판매 중지 객실은 배정할 수 없습니다."},{status:409});
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'ASSIGN_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND status='DUE_IN' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
      ];
      for(const stayDate of datesBetween(String(reservation.arrival_date),String(reservation.departure_date))) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ASSIGN_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.room_assigned', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:body.roomId}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "move_room" && reservation) {
      if(reservation.status!=="IN_HOUSE"||!reservation.room_id) return Response.json({error:"투숙 중이고 객실이 배정된 예약만 룸 무브할 수 있습니다."},{status:409});
      const expectedVersion=Number(body.expectedVersion); if(expectedVersion!==Number(reservation.version)) return Response.json({error:"다른 작업자가 예약을 변경했습니다. 화면을 새로고침하세요."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"룸 무브 사유를 입력하세요."},{status:400});
      if(body.roomId===reservation.room_id) return Response.json({error:"현재 객실과 다른 객실을 선택하세요."},{status:400});
      const room=await db.prepare("SELECT * FROM rooms WHERE id=? AND property_id='prop-seoul' AND active=1").bind(body.roomId).first<Record<string,unknown>>();
      if(!room||room.front_desk_status!=="VACANT"||!["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"공실이며 청소 또는 점검이 완료된 객실만 이동할 수 있습니다."},{status:409});
      const futureDates=datesBetween(businessDate,String(reservation.departure_date)); if(!futureDates.length) return Response.json({error:"남은 숙박일이 없습니다."},{status:409});
      const moveId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_mutations VALUES (?, 'prop-seoul', ?, ?, 'MOVE_ROOM', ?, ?)").bind(crypto.randomUUID(),body.reservationId,expectedVersion,actor,now),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("UPDATE reservations SET room_id=?, version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE' AND version=?").bind(body.roomId,now,body.reservationId,expectedVersion),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=?").bind(String(reservation.room_id)),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=? AND front_desk_status='VACANT'").bind(body.roomId),
        db.prepare("INSERT INTO room_moves VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?)").bind(moveId,body.reservationId,String(reservation.room_id),body.roomId,businessDate,body.reason.trim(),body.notes||"",actor,now),
      ];
      for(const stayDate of futureDates) statements.push(db.prepare("INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(body.reservationId,body.roomId,stayDate));
      statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 1, NULL, '룸 무브 출발 객실', ?)").bind(crypto.randomUUID(),String(reservation.room_id),businessDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MOVE_ROOM', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({roomId:reservation.room_id}),JSON.stringify({roomId:body.roomId,reason:body.reason}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.room_moved', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,fromRoomId:reservation.room_id,toRoomId:body.roomId,reason:body.reason}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "cancel_reservation" && reservation) {
      if(reservation.status!=="DUE_IN") return Response.json({error:"도착 예정 예약만 취소할 수 있습니다."},{status:409});
      if(!body.reason?.trim()) return Response.json({error:"예약 취소 사유를 입력하세요."},{status:400});
      const groupEntry=await db.prepare("SELECT * FROM rooming_list_entries WHERE reservation_id=?").bind(body.reservationId).first<Record<string,unknown>>();
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'CANCELLED', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CANCELLED', version=version+1, notes=notes || ?, updated_at=? WHERE id=? AND status='DUE_IN'").bind(`\n[취소] ${body.reason.trim()}`,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CANCEL_RESERVATION', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CANCELLED",reason:body.reason.trim()}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.cancelled', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,reason:body.reason.trim()}),now),
      ];
      if(groupEntry){statements.push(db.prepare("DELETE FROM block_pickup_nights WHERE rooming_entry_id=?").bind(String(groupEntry.id)));statements.push(db.prepare("UPDATE rooming_list_entries SET status='CANCELLED',version=version+1,updated_at=? WHERE id=?").bind(now,String(groupEntry.id)));}
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "update_inventory_control") {
      const stayDate=String(body.stayDate), roomType=await db.prepare("SELECT * FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first<Record<string,unknown>>(); if(!roomType) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const horizon=new Date(`${businessDate}T00:00:00Z`);horizon.setUTCDate(horizon.getUTCDate()+365); if(stayDate<businessDate||stayDate>horizon.toISOString().slice(0,10)) return Response.json({error:"영업일부터 365일 범위만 수정할 수 있습니다."},{status:400});
      const capacity=await db.prepare("SELECT COUNT(*) count FROM rooms WHERE property_id='prop-seoul' AND room_type_id=? AND active=1 AND housekeeping_status<>'OUT_OF_SERVICE'").bind(body.roomTypeId).first<{count:number}>(); const physical=Number(capacity?.count??0);
      const sellLimit=body.sellLimit===""?physical:Number(body.sellLimit), minStay=Number(body.minStay||1), price=body.priceOverride===""?null:Number(body.priceOverride), closed=body.closed==="true"?1:0;
      if(!Number.isInteger(sellLimit)||sellLimit<0||sellLimit>physical||!Number.isInteger(minStay)||minStay<1||minStay>30||price!==null&&(!Number.isFinite(price)||price<0)) return Response.json({error:"판매 수량·최소 숙박·요금을 올바르게 입력하세요."},{status:400});
      const reserved=await db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first<{count:number}>(); if(!closed&&sellLimit<Number(reserved?.count??0)) return Response.json({error:"이미 확정된 예약 수보다 판매 한도를 낮출 수 없습니다."},{status:409});
      const existing=await db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(body.roomTypeId,stayDate).first(); const controlId=String((existing as Record<string,unknown>|null)?.id??crypto.randomUUID());
      const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO inventory_controls VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(property_id,room_type_id,stay_date) DO UPDATE SET sell_limit=excluded.sell_limit,closed=excluded.closed,min_stay=excluded.min_stay,close_to_arrival=excluded.close_to_arrival,close_to_departure=excluded.close_to_departure,price_override=excluded.price_override,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(controlId,body.roomTypeId,stayDate,sellLimit,closed,minStay,body.cta==="true"?1:0,body.ctd==="true"?1:0,price,now,actor),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_INVENTORY_CONTROL', 'inventory_control', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,controlId,existing?JSON.stringify(existing):null,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,cta:body.cta==="true",ctd:body.ctd==="true",price}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'inventory.updated', 'room_type', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.roomTypeId,JSON.stringify({roomTypeId:body.roomTypeId,stayDate,sellLimit,closed:Boolean(closed),minStay,price}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "create_account_profile") {
      const type=String(body.type),name=body.name?.trim(); if(!["COMPANY","TRAVEL_AGENT","SOURCE","GROUP"].includes(type)||!name) return Response.json({error:"프로필 유형과 이름을 올바르게 입력하세요."},{status:400});
      const profileId=crypto.randomUUID(); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO account_profiles VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)").bind(profileId,type,name,body.externalId?.trim()||null,body.email?.trim()||null,body.phone?.trim()||null,body.negotiatedRateCode?.trim()||null,body.creditStatus||"CASH",body.notes||"",now,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_ACCOUNT_PROFILE', 'account_profile', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,profileId,JSON.stringify({type,name,externalId:body.externalId||null}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'profile.created', 'account_profile', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),profileId,JSON.stringify({profileId,type,name}),now),
      ];
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "create_business_block") {
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.name?.trim()||!stayDates.length) return Response.json({error:"블록 이름과 올바른 일정을 입력하세요."},{status:400});
      let allocations:Array<{roomTypeId:string;rooms:number;rate:number}>; try{allocations=JSON.parse(body.allocations||"[]") as Array<{roomTypeId:string;rooms:number;rate:number}>}catch{return Response.json({error:"객실 할당 정보가 올바르지 않습니다."},{status:400})}
      allocations=allocations.filter(item=>item.roomTypeId&&Number.isInteger(Number(item.rooms))&&Number(item.rooms)>0&&Number(item.rate)>=0).map(item=>({...item,rooms:Number(item.rooms),rate:Number(item.rate)})); if(!allocations.length) return Response.json({error:"한 개 이상의 객실 타입 할당을 입력하세요."},{status:400});
      const types=await db.prepare("SELECT id FROM room_types WHERE property_id='prop-seoul'").all<{id:string}>(); const validTypes=new Set(types.results.map(type=>type.id)); if(allocations.some(item=>!validTypes.has(item.roomTypeId))) return Response.json({error:"객실 타입이 올바르지 않습니다."},{status:400});
      const accountId=body.accountProfileId||null,groupId=body.groupProfileId||null; if(accountId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND type IN ('COMPANY','TRAVEL_AGENT','SOURCE') AND active=1").bind(accountId).first()) return Response.json({error:"유효한 회사·여행사·소스 프로필을 선택하세요."},{status:400}); if(groupId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND type='GROUP' AND active=1").bind(groupId).first()) return Response.json({error:"유효한 그룹 프로필을 선택하세요."},{status:400});
      const blockId=crypto.randomUUID(),code=body.code?.trim()||`BLK-${body.arrivalDate.replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,status=["TENTATIVE","DEFINITE"].includes(body.status)?body.status:"TENTATIVE",cutoffDate=body.cutoffDate||body.arrivalDate,deduct=body.deductInventory==="false"?0:1;
      const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO business_blocks VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 1, NULL, ?, ?)").bind(blockId,code,body.name.trim(),accountId,groupId,body.arrivalDate,body.departureDate,status,body.reservationMethod||"ROOMING_LIST",deduct,cutoffDate,body.notes||"",now,now)];
      for(const allocation of allocations) for(const stayDate of stayDates) statements.push(db.prepare("INSERT INTO block_inventory VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)").bind(crypto.randomUUID(),blockId,allocation.roomTypeId,stayDate,allocation.rooms,allocation.rooms,allocation.rate,cutoffDate,now));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_BUSINESS_BLOCK', 'business_block', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,blockId,JSON.stringify({code,name:body.name,status,arrivalDate:body.arrivalDate,departureDate:body.departureDate,allocations}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.created', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),blockId,JSON.stringify({blockId,code,status}),now));
      if(idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "update_block_inventory") {
      const row=await db.prepare("SELECT bi.*,bb.status block_status FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.block_id=? AND bi.room_type_id=? AND bi.stay_date=?").bind(body.blockId,body.roomTypeId,body.stayDate).first<Record<string,unknown>>(); if(!row||!["TENTATIVE","DEFINITE"].includes(String(row.block_status))) return Response.json({error:"수정 가능한 블록 재고를 찾지 못했습니다."},{status:409});
      const rooms=Number(body.rooms),rate=Number(body.rate); if(!Number.isInteger(rooms)||rooms<Number(row.picked_up)||!Number.isFinite(rate)||rate<0) return Response.json({error:"픽업 수보다 낮지 않은 객실 수와 올바른 요금을 입력하세요."},{status:400});
      const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=?,rate=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(rooms,rate,now,row.id,Number(row.version)),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPDATE_BLOCK_INVENTORY', 'block_inventory', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(row.id),JSON.stringify(row),JSON.stringify({currentRooms:rooms,rate}),now),db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.inventory_updated', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId,roomTypeId:body.roomTypeId,stayDate:body.stayDate,rooms,rate}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "add_rooming_entry") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block) return Response.json({error:"픽업 가능한 블록을 찾지 못했습니다."},{status:409});
      const stayDates=datesBetween(body.arrivalDate,body.departureDate); if(!body.firstName?.trim()||!body.lastName?.trim()||!stayDates.length||body.arrivalDate<String(block.arrival_date)||body.departureDate>String(block.departure_date)) return Response.json({error:"고객명과 블록 범위 안의 일정을 입력하세요."},{status:400});
      const grid=await db.prepare("SELECT * FROM block_inventory WHERE block_id=? AND room_type_id=? AND stay_date>=? AND stay_date<? ORDER BY stay_date").bind(body.blockId,body.roomTypeId,body.arrivalDate,body.departureDate).all<Record<string,unknown>>(); if(grid.results.length!==stayDates.length) return Response.json({error:"선택한 객실 타입의 블록 할당이 일정 전체에 없습니다."},{status:409});
      const entryId=crypto.randomUUID(),rate=Number(body.rate)||Number(grid.results[0]?.rate??0); const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO rooming_list_entries VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, 1, ?, ?)").bind(entryId,body.blockId,body.firstName.trim(),body.lastName.trim(),body.email||null,body.phone||null,body.arrivalDate,body.departureDate,body.roomTypeId,rate,body.notes||"",now,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'ADD_ROOMING_ENTRY', 'rooming_list_entry', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,entryId,JSON.stringify({blockId:body.blockId,firstName:body.firstName,lastName:body.lastName,roomTypeId:body.roomTypeId}),now)]; if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "pickup_rooming_entry") {
      const entry=await db.prepare("SELECT rl.*,bb.code block_code,bb.status block_status FROM rooming_list_entries rl JOIN business_blocks bb ON bb.id=rl.block_id WHERE rl.id=?").bind(body.entryId).first<Record<string,unknown>>(); if(!entry||entry.status!=="PENDING"||!["TENTATIVE","DEFINITE"].includes(String(entry.block_status))) return Response.json({error:"이미 픽업됐거나 픽업할 수 없는 rooming list 항목입니다."},{status:409});
      const reservationId=crypto.randomUUID(),guestId=crypto.randomUUID(),confirmation=`SEL-${String(entry.arrival_date).replaceAll("-","").slice(2)}-${Math.floor(1000+Math.random()*9000)}`,stayDates=datesBetween(String(entry.arrival_date),String(entry.departure_date)); const statements:D1PreparedStatement[]=[
        db.prepare("INSERT INTO guests VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'NONE', 'KR', '[]', ?)").bind(guestId,String(entry.first_name),String(entry.last_name),entry.email??null,entry.phone??null,now),
        db.prepare("INSERT INTO reservations VALUES (?, ?, 'prop-seoul', ?, ?, NULL, ?, ?, 'DUE_IN', 1, 0, 'Group', ?, ?, NULL, ?, 1, ?, ?)").bind(reservationId,confirmation,guestId,String(entry.room_type_id),String(entry.arrival_date),String(entry.departure_date),String(entry.block_code),Number(entry.rate),`Block ${entry.block_code} · Rooming list`,now,now),
        db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, 1, 'Guest Folio', 'GUEST', NULL, 'OPEN', ?, ?, NULL)").bind(`fw-${reservationId}`,reservationId,now,actor),
      ];
      for(const stayDate of stayDates){statements.push(db.prepare("INSERT INTO block_pickup_nights(property_id,block_id,rooming_entry_id,room_type_id,stay_date,created_at) VALUES ('prop-seoul',?,?,?,?,?)").bind(String(entry.block_id),String(entry.id),String(entry.room_type_id),stayDate,now));statements.push(db.prepare("INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',?,?,?)").bind(reservationId,String(entry.room_type_id),stayDate));}
      statements.push(db.prepare("UPDATE rooming_list_entries SET status='PICKED_UP',reservation_id=?,version=version+1,updated_at=? WHERE id=? AND status='PENDING'").bind(reservationId,now,String(entry.id))); statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'PICKUP_ROOMING_ENTRY', 'rooming_list_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(entry.id),JSON.stringify(entry),JSON.stringify({status:"PICKED_UP",reservationId,confirmation}),now)); statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.reservation_picked_up', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),String(entry.block_id),JSON.stringify({blockId:entry.block_id,entryId:entry.id,reservationId,confirmation}),now)); if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)); await db.batch(statements);
    } else if (body.action === "cutoff_block") {
      const block=await db.prepare("SELECT * FROM business_blocks WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(body.blockId).first<Record<string,unknown>>(); if(!block)return Response.json({error:"마감 가능한 블록을 찾지 못했습니다."},{status:409}); const statements:D1PreparedStatement[]=[db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=?").bind(now,body.blockId),db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=? AND status IN ('TENTATIVE','DEFINITE')").bind(now,now,body.blockId),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CUTOFF_BLOCK', 'business_block', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.blockId,JSON.stringify(block),JSON.stringify({status:"CUTOFF"}),now),db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.blockId,JSON.stringify({blockId:body.blockId}),now)];if(idempotencyKey)statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));await db.batch(statements);
    } else if (body.action === "create_channel_connection") {
      const provider=body.provider?.trim().toUpperCase(),externalPropertyId=body.externalPropertyId?.trim();if(!provider||!externalPropertyId)return Response.json({error:"채널과 외부 호텔 ID를 입력하세요."},{status:400});const connectionId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_connections VALUES (?, 'prop-seoul', ?, ?, ?, 'SANDBOX', 'ACTIVE', NULL, ?, ?, ?)").bind(connectionId,provider,externalPropertyId,body.name?.trim()||`${provider} Sandbox`,now,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_CHANNEL_CONNECTION', 'channel_connection', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,connectionId,JSON.stringify({provider,externalPropertyId,environment:"SANDBOX"}),now)]);
    } else if (body.action === "create_channel_mapping") {
      const connection=await db.prepare("SELECT id FROM channel_connections WHERE id=? AND status='ACTIVE'").bind(body.connectionId).first(),roomType=await db.prepare("SELECT id FROM room_types WHERE id=? AND property_id='prop-seoul'").bind(body.roomTypeId).first();if(!connection||!roomType||!body.externalRoomTypeId?.trim()||!body.externalRatePlanId?.trim())return Response.json({error:"활성 연결, 객실 타입, 외부 room/rate ID를 입력하세요."},{status:400});const mappingId=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO channel_mappings VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 1, ?, ?)").bind(mappingId,body.connectionId,body.roomTypeId,body.externalRoomTypeId.trim(),body.ratePlan||"OTA",body.externalRatePlanId.trim(),now,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_CHANNEL_MAPPING', 'channel_mapping', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,mappingId,JSON.stringify({connectionId:body.connectionId,roomTypeId:body.roomTypeId,externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId}),now)]);
    } else if (body.action === "queue_ari_delta") {
      const mapping=await db.prepare("SELECT m.*,c.provider FROM channel_mappings m JOIN channel_connections c ON c.id=m.connection_id WHERE m.id=? AND m.active=1 AND c.status='ACTIVE'").bind(body.mappingId).first<Record<string,unknown>>(),dates=datesBetween(body.startDate,(()=>{const end=new Date(`${body.endDate}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);return end.toISOString().slice(0,10)})());if(!mapping||!dates.length)return Response.json({error:"활성 매핑과 올바른 ARI 일자 범위를 선택하세요."},{status:400});const physicalRow=await db.prepare("SELECT COUNT(*) count,MAX(rt.base_rate) base_rate FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.property_id='prop-seoul' AND r.room_type_id=? AND r.active=1 AND r.housekeeping_status<>'OUT_OF_SERVICE'").bind(mapping.room_type_id).first<{count:number;base_rate:number}>(),statements:D1PreparedStatement[]=[];
      for(const stayDate of dates){const [control,booked,held,prior]=await Promise.all([db.prepare("SELECT * FROM inventory_controls WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(mapping.room_type_id,stayDate).first<Record<string,unknown>>(),db.prepare("SELECT COUNT(*) count FROM reservation_type_nights WHERE property_id='prop-seoul' AND room_type_id=? AND stay_date=?").bind(mapping.room_type_id,stayDate).first<{count:number}>(),db.prepare("SELECT COALESCE(SUM(bi.current_rooms-bi.picked_up),0) count FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id='prop-seoul' AND bi.room_type_id=? AND bi.stay_date=? AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')").bind(mapping.room_type_id,stayDate).first<{count:number}>(),db.prepare("SELECT COALESCE(MAX(revision),0)+1 revision FROM ari_updates WHERE mapping_id=? AND stay_date=?").bind(mapping.id,stayDate).first<{revision:number}>()]);const sellLimit=control?.sell_limit==null?Number(physicalRow?.count??0):Number(control.sell_limit),available=Boolean(control?.closed)?0:Math.max(0,sellLimit-Number(booked?.count??0)-Number(held?.count??0)),revision=Number(prior?.revision??1),payload={roomstosell:available,closed:Boolean(control?.closed),minimumstay:Number(control?.min_stay??1),closedonarrival:Boolean(control?.close_to_arrival),closedondeparture:Boolean(control?.close_to_departure),rate:Number(control?.price_override??physicalRow?.base_rate??0),currency:"KRW",date:stayDate};const ariId=crypto.randomUUID();statements.push(db.prepare("INSERT INTO ari_updates VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'KRW', ?, 'PENDING', 0, ?, NULL, NULL)").bind(ariId,mapping.connection_id,mapping.id,stayDate,revision,available,payload.closed?1:0,payload.minimumstay,payload.closedonarrival?1:0,payload.closedondeparture?1:0,payload.rate,JSON.stringify(payload),now));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'channel.ari_delta', 'ari_update', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),ariId,JSON.stringify(payload),now));}
      await db.batch(statements);
    } else if (body.action === "dispatch_ari_update") {
      const update=await db.prepare("SELECT a.*,c.provider FROM ari_updates a JOIN channel_connections c ON c.id=a.connection_id WHERE a.id=? AND a.status IN ('PENDING','FAILED')").bind(body.updateId).first<Record<string,unknown>>();if(!update)return Response.json({error:"전송 또는 재처리 가능한 ARI 업데이트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(update.attempts)+1;await db.batch([db.prepare("UPDATE ari_updates SET status=?,attempts=?,sent_at=?,last_error=? WHERE id=?").bind(failed?"FAILED":"SENT",attempt,failed?null:now,failed?"SANDBOX_TIMEOUT":null,update.id),db.prepare("UPDATE channel_connections SET last_sync_at=CASE WHEN ?=1 THEN last_sync_at ELSE ? END,updated_at=? WHERE id=?").bind(failed?1:0,now,now,update.connection_id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'OUTBOUND', ?, 'ari_update', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),update.provider,update.id,attempt,failed?"FAILED":"ACKED",failed?504:200,failed?"TIMEOUT":null,failed?"Sandbox timeout":null,update.payload_json,now,actor)]);
    } else if (body.action === "ingest_channel_message") {
      const connection=await db.prepare("SELECT * FROM channel_connections WHERE id=? AND status='ACTIVE'").bind(body.connectionId).first<Record<string,unknown>>();if(!connection)return Response.json({error:"활성 채널 연결을 선택하세요."},{status:400});const duplicate=await db.prepare("SELECT id FROM inbound_channel_messages WHERE connection_id=? AND message_id=?").bind(body.connectionId,body.messageId).first();if(duplicate)return Response.json(await snapshot(db,principal),{headers:{"X-Channel-Duplicate":"true"}});
      const payload:ChannelPayload={connectionId:body.connectionId,messageId:body.messageId,eventType:body.eventType,externalReservationId:body.externalReservationId,revision:Number(body.revision),externalRoomTypeId:body.externalRoomTypeId,externalRatePlanId:body.externalRatePlanId,firstName:body.firstName,lastName:body.lastName,email:body.email,arrivalDate:body.arrivalDate,departureDate:body.departureDate,adults:Number(body.adults),children:Number(body.children),nightlyRate:Number(body.nightlyRate),currency:body.currency||"KRW"},messageId=crypto.randomUUID();await db.prepare("INSERT INTO inbound_channel_messages VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, NULL, ?, NULL)").bind(messageId,body.connectionId,connection.provider,body.messageId,body.eventType.toUpperCase(),body.externalReservationId,Number(body.revision),JSON.stringify(payload),now).run();const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=?").bind(messageId).first<Record<string,unknown>>();
      try{await processChannelMessage(db,message!,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error);await db.batch([db.prepare("UPDATE inbound_channel_messages SET status='FAILED',attempts=attempts+1,last_error=? WHERE id=?").bind(detail,messageId),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, 1, 'FAILED', 409, 'PROCESSING_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),connection.provider,messageId,detail,JSON.stringify(payload),now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId,status:"FAILED"},{status:409});}
    } else if (body.action === "replay_channel_message") {
      const message=await db.prepare("SELECT * FROM inbound_channel_messages WHERE id=? AND status='FAILED'").bind(body.messageId).first<Record<string,unknown>>();if(!message)return Response.json({error:"DLQ에서 재처리할 메시지를 찾지 못했습니다."},{status:409});const payload=JSON.parse(String(message.payload_json)) as ChannelPayload;try{await processChannelMessage(db,message,payload,actor,now);}catch(error){const detail=error instanceof Error?error.message:String(error),attempt=Number(message.attempts)+1;await db.batch([db.prepare("UPDATE inbound_channel_messages SET attempts=?,last_error=? WHERE id=?").bind(attempt,detail,message.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'INBOUND', ?, 'channel_message', ?, ?, 'FAILED', 409, 'REPLAY_ERROR', ?, ?, ?, ?)").bind(crypto.randomUUID(),message.provider,message.id,attempt,detail,message.payload_json,now,actor)]);invalidateSnapshots();return Response.json({error:detail,messageId:message.id,status:"FAILED"},{status:409});}
    } else if (body.action === "dispatch_outbox_event") {
      const event=await db.prepare("SELECT * FROM outbox_events WHERE id=? AND status IN ('PENDING','FAILED')").bind(body.eventId).first<Record<string,unknown>>();if(!event)return Response.json({error:"전송 또는 재처리 가능한 outbox 이벤트가 없습니다."},{status:409});const failed=body.outcome==="FAIL",attempt=Number(event.attempts)+1,provider=body.provider||"WEBHOOK";await db.batch([db.prepare("UPDATE outbox_events SET status=?,attempts=?,published_at=? WHERE id=?").bind(failed?"FAILED":"PUBLISHED",attempt,failed?null:now,event.id),db.prepare("INSERT INTO integration_delivery_attempts VALUES (?, 'prop-seoul', 'OUTBOUND', ?, 'outbox_event', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),provider,event.id,attempt,failed?"FAILED":"ACKED",failed?503:200,failed?"UNAVAILABLE":null,failed?"Sandbox endpoint unavailable":null,event.payload_json,now,actor)]);
    } else if (body.action === "open_cashier") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>();
      const openingAmount = Number(body.openingAmount || 0); if (!Number.isFinite(openingAmount) || openingAmount < 0) return Response.json({error:"시재금은 0원 이상이어야 합니다."},{status:400});
      const existing = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (existing) return Response.json({error:"이미 개시된 캐셔 세션이 있습니다."},{status:409});
      const cashierId = crypto.randomUUID(); const statements = [
        db.prepare("INSERT INTO cashier_sessions VALUES (?, 'prop-seoul', ?, ?, 'OPEN', ?, NULL, NULL, NULL, ?, NULL)").bind(cashierId,actor,property?.business_date,openingAmount,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'OPEN_CASHIER', 'cashier_session', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,cashierId,JSON.stringify({openingAmount,businessDate:property?.business_date}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "close_cashier") {
      const session = await db.prepare("SELECT * FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(actor).first<Record<string,unknown>>();
      if (!session) return Response.json({error:"개시된 캐셔 세션이 없습니다."},{status:409});
      const cash = await db.prepare("SELECT (SELECT COALESCE(SUM(CASE WHEN kind='PAYMENT' THEN amount WHEN kind IN ('PAYMENT_REVERSAL','REFUND') THEN -amount ELSE 0 END),0) FROM folio_entries WHERE property_id='prop-seoul' AND business_date=? AND created_by=? AND payment_method='CASH')+(SELECT COALESCE(SUM(credit),0) FROM ar_ledger_entries WHERE property_id='prop-seoul' AND business_date=? AND created_by=? AND kind='PAYMENT' AND payment_method='CASH') total").bind(session.business_date,actor,session.business_date,actor).first<{total:number}>();
      const expected = Number(session.opening_amount)+Number(cash?.total??0), counted=Number(body.countedAmount);
      if (!Number.isFinite(counted) || counted < 0) return Response.json({error:"실사 현금을 올바르게 입력하세요."},{status:400});
      const variance = counted-expected; const statements = [
        db.prepare("UPDATE cashier_sessions SET status='CLOSED', expected_amount=?, counted_amount=?, variance=?, closed_at=? WHERE id=? AND status='OPEN'").bind(expected,counted,variance,now,session.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_CASHIER', 'cashier_session', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,session.id,JSON.stringify(session),JSON.stringify({status:"CLOSED",expected,counted,variance}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "run_night_audit") {
      const property = await db.prepare("SELECT business_date FROM properties WHERE id='prop-seoul'").first<{business_date:string}>(); const businessDate=String(property?.business_date);
      const controls = await operationalControls(db,businessDate,actor);
      if (!controls.canClose) return Response.json({error:"영업일 마감 선행조건이 충족되지 않았습니다.",blockers:controls.blockers},{status:409});
      const stays = await db.prepare("SELECT r.id, r.room_id, r.nightly_rate FROM reservations r WHERE r.property_id='prop-seoul' AND r.status='IN_HOUSE' AND r.arrival_date<=? AND r.departure_date>? AND NOT EXISTS (SELECT 1 FROM folio_entries f WHERE f.reservation_id=r.id AND f.business_date=? AND f.kind='CHARGE' AND f.code='ROOM')").bind(businessDate,businessDate,businessDate).all<{id:string;room_id:string;nightly_rate:number}>();
      const cutoffBlocks=await db.prepare("SELECT id FROM business_blocks WHERE property_id='prop-seoul' AND status IN ('TENTATIVE','DEFINITE') AND cutoff_date IS NOT NULL AND cutoff_date<=?").bind(businessDate).all<{id:string}>();
      const next = new Date(`${businessDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1); const nextDate=next.toISOString().slice(0,10); const auditId=crypto.randomUUID();
      const statements = [db.prepare("INSERT INTO night_audits VALUES (?, 'prop-seoul', ?, 'COMPLETED', '[]', ?, ?, ?, ?)").bind(auditId,businessDate,JSON.stringify({roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length,nextBusinessDate:nextDate}),now,now,actor)];
      for (const stay of stays.results) {
        const entryId=crypto.randomUUID(),parts=inclusiveComponents(Number(stay.nightly_rate),0.10,0);
        statements.push(db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', 'ROOM', '객실료 자동 전기', ?, NULL, ?, ?, 'night-audit', NULL)").bind(entryId,stay.id,parts.total,businessDate,now));
        statements.push(db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,stay.id,`fw-${stay.id}`,parts.net,parts.tax,parts.service,now));
        if (stay.room_id) statements.push(db.prepare("INSERT INTO housekeeping_tasks VALUES (?, 'prop-seoul', ?, ?, 'PENDING', 2, NULL, '스테이오버 객실', ?)").bind(crypto.randomUUID(),stay.room_id,nextDate,now));
      }
      for(const block of cutoffBlocks.results){statements.push(db.prepare("UPDATE block_inventory SET current_rooms=picked_up,version=version+1,updated_at=? WHERE block_id=?").bind(now,block.id));statements.push(db.prepare("UPDATE business_blocks SET status='CUTOFF',cutoff_processed_at=?,version=version+1,updated_at=? WHERE id=?").bind(now,now,block.id));statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'block.cutoff', 'business_block', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),block.id,JSON.stringify({blockId:block.id,automatic:true,businessDate}),now));}
      statements.push(db.prepare("UPDATE properties SET business_date=? WHERE id='prop-seoul' AND business_date=?").bind(nextDate,businessDate));
      statements.push(db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CLOSE_BUSINESS_DATE', 'night_audit', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,auditId,JSON.stringify({businessDate}),JSON.stringify({nextDate,roomPostings:stays.results.length,blockCutoffs:cutoffBlocks.results.length}),now));
      statements.push(db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'business_date.closed', 'night_audit', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),auditId,JSON.stringify({businessDate,nextDate}),now));
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "mark_no_show" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 노쇼 처리할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 노쇼 처리할 수 없습니다."},{status:409});
      const statements = [
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'NO_SHOW', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='NO_SHOW', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=?").bind(body.reservationId),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'MARK_NO_SHOW', 'reservation', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"NO_SHOW"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'reservation.no_show', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId}),now),
      ];
      if (idempotencyKey) statements.push(db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now));
      await db.batch(statements);
    } else if (body.action === "check_in" && reservation) {
      if (reservation.status !== "DUE_IN") return Response.json({error:"도착 예정 예약만 체크인할 수 있습니다."},{status:409});
      if (String(reservation.arrival_date) > businessDate) return Response.json({error:"도착일 이전에는 체크인할 수 없습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"객실 배정이 필요합니다."},{status:409});
      const room = await db.prepare("SELECT * FROM rooms WHERE id=?").bind(reservation.room_id).first<Record<string, unknown>>();
      if (!room || !["CLEAN","INSPECTED"].includes(String(room.housekeeping_status))) return Response.json({error:"청소 완료 또는 점검 완료 객실만 체크인할 수 있습니다."},{status:409});
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'DUE_IN', 'IN_HOUSE', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='IN_HOUSE', version=version+1, updated_at=? WHERE id=? AND status='DUE_IN'").bind(now, body.reservationId),
        db.prepare("UPDATE rooms SET front_desk_status='OCCUPIED', version=version+1 WHERE id=?").bind(reservation.room_id),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_IN","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"IN_HOUSE"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_in', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "check_out" && reservation) {
      if (reservation.status !== "IN_HOUSE") return Response.json({error:"투숙 중 예약만 체크아웃할 수 있습니다."},{status:409});
      if (!reservation.room_id) return Response.json({error:"예약에 배정된 객실이 없습니다."},{status:409});
      const bal = await db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYMENT' THEN -amount WHEN 'CHARGE_REVERSAL' THEN -amount WHEN 'PAYMENT_REVERSAL' THEN amount WHEN 'REFUND' THEN amount ELSE 0 END),0) balance FROM folio_entries WHERE reservation_id=?").bind(body.reservationId).first<{balance:number}>();
      if (Math.abs(bal?.balance ?? 0) > .01) return Response.json({error:"잔액을 정산한 뒤 체크아웃하세요."},{status:409});
      const task = crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO reservation_transitions VALUES (?, 'prop-seoul', ?, 'IN_HOUSE', 'CHECKED_OUT', ?, ?)").bind(crypto.randomUUID(),body.reservationId,actor,now),
        db.prepare("UPDATE reservations SET status='CHECKED_OUT', departure_date=CASE WHEN departure_date>? THEN ? ELSE departure_date END, version=version+1, updated_at=? WHERE id=? AND status='IN_HOUSE'").bind(businessDate,businessDate,now,body.reservationId),
        db.prepare("DELETE FROM reservation_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("DELETE FROM reservation_type_nights WHERE reservation_id=? AND stay_date>=?").bind(body.reservationId,businessDate),
        db.prepare("UPDATE rooms SET front_desk_status='VACANT', housekeeping_status='DIRTY', version=version+1 WHERE id=?").bind(reservation.room_id),
        db.prepare("INSERT INTO housekeeping_tasks VALUES (?, ?, ?, ?, 'PENDING', 1, NULL, '체크아웃 객실', ?)").bind(task,"prop-seoul",reservation.room_id,businessDate,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"CHECK_OUT","reservation",body.reservationId,JSON.stringify(reservation),JSON.stringify({status:"CHECKED_OUT"}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'stay.checked_out', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,roomId:reservation.room_id}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_payment" && reservation) {
      const amount = Number(body.amount); if (!(amount > 0)) return Response.json({error:"결제 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"결제 전 캐셔 세션을 개시하세요."},{status:409});
      const windowId=await folioWindowFor(db,body.reservationId,"PAYMENT",body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, ?, ?, 'PAYMENT', 'PAYMENT', '프런트 결제', ?, ?, ?, ?, ?, NULL)").bind(entryId,"prop-seoul",body.reservationId,amount,body.method || "CARD",businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,amount,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.payment_posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,method:body.method||"CARD"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "post_charge" && reservation) {
      const amount=Number(body.amount); if(!(amount>0)) return Response.json({error:"전기 금액이 올바르지 않습니다."},{status:400});
      const cashier = await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();
      if (!cashier) return Response.json({error:"비용 전기 전 캐셔 세션을 개시하세요."},{status:409});
      const code=(body.code||"MISC").toUpperCase(),transactionCode=await db.prepare("SELECT * FROM transaction_codes WHERE property_id='prop-seoul' AND code=? AND active=1").bind(code).first<Record<string,unknown>>();
      if(!transactionCode)return Response.json({error:"활성 거래 코드를 선택하세요."},{status:400});
      const parts=inclusiveComponents(amount,Number(transactionCode.tax_rate),Number(transactionCode.service_rate)),windowId=await folioWindowFor(db,body.reservationId,code,body.windowId),entryId=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(entryId,body.reservationId,code,body.description||String(transactionCode.name),parts.total,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', NULL, NULL, ?)").bind(entryId,body.reservationId,windowId,parts.net,parts.tax,parts.service,now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'folio.posted', 'reservation', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),body.reservationId,JSON.stringify({reservationId:body.reservationId,amount,kind:"CHARGE"}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else if (body.action === "create_folio_window" && reservation) {
      const next=await db.prepare("SELECT COALESCE(MAX(window_no),0)+1 next_no FROM folio_windows WHERE reservation_id=?").bind(body.reservationId).first<{next_no:number}>(),windowId=crypto.randomUUID(),payeeType=body.payeeType||"GUEST";
      if(!["GUEST","COMPANY","TRAVEL_AGENT","GROUP"].includes(payeeType))return Response.json({error:"올바른 지불 주체 유형을 선택하세요."},{status:400});
      if(body.accountProfileId&&!await db.prepare("SELECT id FROM account_profiles WHERE id=? AND active=1").bind(body.accountProfileId).first())return Response.json({error:"유효한 계정 프로필을 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_windows VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL)").bind(windowId,body.reservationId,Number(next?.next_no??1),body.name?.trim()||`Window ${next?.next_no??1}`,payeeType,body.accountProfileId||null,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'CREATE_FOLIO_WINDOW', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({windowId,payeeType}),now)]);
    } else if (body.action === "create_routing_rule" && reservation) {
      const code=(body.code||"").toUpperCase(),target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND status='OPEN'").bind(body.windowId,body.reservationId).first(); if(!code||!target)return Response.json({error:"거래 코드와 열린 대상 폴리오를 선택하세요."},{status:400});
      await db.batch([db.prepare("INSERT INTO folio_routing_rules VALUES (?, 'prop-seoul', ?, ?, ?, 1, ?, ?) ON CONFLICT(reservation_id,transaction_code) DO UPDATE SET target_window_id=excluded.target_window_id,active=1").bind(crypto.randomUUID(),body.reservationId,code,body.windowId,now,actor),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'UPSERT_FOLIO_ROUTING', 'reservation', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,body.reservationId,JSON.stringify({code,windowId:body.windowId}),now)]);
    } else if (body.action === "split_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.kind='CHARGE_REVERSAL'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.kind='CHARGE'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount));
      if(!source||!(amount>0)||amount>Number(source.remaining)+0.001)return Response.json({error:"분할 가능한 원전표 잔액 안에서 금액을 입력하세요."},{status:409});
      const target=await db.prepare("SELECT id FROM folio_windows WHERE id=? AND reservation_id=? AND status='OPEN'").bind(body.targetWindowId,source.reservation_id).first(); if(!target||body.targetWindowId===source.folio_window_id)return Response.json({error:"다른 열린 폴리오 창을 선택하세요."},{status:400});
      const ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),reverseId=crypto.randomUUID(),repostId=crypto.randomUUID(),reason=body.reason?.trim()||"FOLIO_SPLIT";
      await db.batch([
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE_REVERSAL', ?, ?, ?, NULL, ?, ?, ?, ?)").bind(reverseId,source.reservation_id,source.code,`분할 반대전표 · ${source.description}`,amount,businessDate,now,actor,source.id),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(reverseId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'CHARGE', ?, ?, ?, NULL, ?, ?, ?, NULL)").bind(repostId,source.reservation_id,source.code,`분할 전기 · ${source.description}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(repostId,source.reservation_id,body.targetWindowId,net,tax,service,source.id,reason,now),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'SPLIT_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({amount,targetWindowId:body.targetWindowId,reverseId,repostId,reason}),now),
      ]);
    } else if (body.action === "reverse_folio_entry") {
      const source=await db.prepare("SELECT f.*,d.folio_window_id,d.net_amount,d.tax_amount,d.service_amount,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.kind=CASE f.kind WHEN 'CHARGE' THEN 'CHARGE_REVERSAL' ELSE 'PAYMENT_REVERSAL' END),0)-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.kind='REFUND'),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.kind IN ('CHARGE','PAYMENT')").bind(body.entryId).first<Record<string,unknown>>();
      if(!source||Number(source.remaining)<=0.001)return Response.json({error:"이미 전액 반대전표 처리된 전표입니다."},{status:409}); const reason=body.reason?.trim();if(!reason)return Response.json({error:"정정 사유를 입력하세요."},{status:400});
      const amount=roundMoney(Number(source.remaining)),ratio=amount/Number(source.amount),net=roundMoney(Number(source.net_amount)*ratio),tax=roundMoney(Number(source.tax_amount)*ratio),service=roundMoney(amount-net-tax),entryId=crypto.randomUUID(),kind=source.kind==='CHARGE'?'CHARGE_REVERSAL':'PAYMENT_REVERSAL';
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,kind,source.code,`반대전표 · ${source.description}`,amount,source.payment_method??null,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,net,tax,service,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'REVERSE_FOLIO_ENTRY', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({entryId,kind,amount,reason}),now)]);
    } else if (body.action === "refund_payment") {
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"환불 전 캐셔 세션을 개시하세요."},{status:409});
      const source=await db.prepare("SELECT f.*,d.folio_window_id,f.amount-COALESCE((SELECT SUM(x.amount) FROM folio_entries x WHERE x.reverses_entry_id=f.id AND x.kind IN ('PAYMENT_REVERSAL','REFUND')),0) remaining FROM folio_entries f JOIN folio_entry_details d ON d.entry_id=f.id WHERE f.id=? AND f.kind='PAYMENT'").bind(body.entryId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),reason=body.reason?.trim();
      if(!source||source.payment_method==='DIRECT_BILL'||!(amount>0)||amount>Number(source.remaining)+0.001||!reason)return Response.json({error:"환불 가능 결제와 잔액, 사유를 확인하세요."},{status:409}); const entryId=crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'REFUND', 'REFUND', ?, ?, ?, ?, ?, ?, ?)").bind(entryId,source.reservation_id,`환불 · ${reason}`,amount,source.payment_method,businessDate,now,actor,source.id),db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', ?, ?, ?)").bind(entryId,source.reservation_id,source.folio_window_id,amount,source.id,reason,now),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'REFUND_PAYMENT', 'folio_entry', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(source.id),JSON.stringify(source),JSON.stringify({entryId,amount,reason}),now)]);
    } else if (body.action === "transfer_to_ar") {
      const window=await db.prepare(`SELECT w.*,r.id reservation_id,COALESCE(SUM(CASE f.kind WHEN 'CHARGE' THEN f.amount WHEN 'PAYMENT' THEN -f.amount WHEN 'CHARGE_REVERSAL' THEN -f.amount WHEN 'PAYMENT_REVERSAL' THEN f.amount WHEN 'REFUND' THEN f.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.net_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.net_amount ELSE 0 END),0) net_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.tax_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.tax_amount ELSE 0 END),0) tax_total,COALESCE(SUM(CASE WHEN f.kind='CHARGE' THEN d.service_amount WHEN f.kind='CHARGE_REVERSAL' THEN -d.service_amount ELSE 0 END),0) service_total FROM folio_windows w JOIN reservations r ON r.id=w.reservation_id LEFT JOIN folio_entry_details d ON d.folio_window_id=w.id LEFT JOIN folio_entries f ON f.id=d.entry_id WHERE w.id=? AND w.status='OPEN' GROUP BY w.id,r.id`).bind(body.windowId).first<Record<string,unknown>>(),profile=await db.prepare("SELECT * FROM account_profiles WHERE id=? AND property_id='prop-seoul' AND active=1 AND credit_status='DIRECT_BILL'").bind(body.accountProfileId).first<Record<string,unknown>>();
      if(!window||Number(window.balance)<=0.001||!profile)return Response.json({error:"잔액이 있는 열린 폴리오와 후불 승인 계정을 선택하세요."},{status:409}); const dueDate=body.dueDate;if(!dueDate||dueDate<businessDate)return Response.json({error:"청구서 만기일을 확인하세요."},{status:400});
      const arAccountId=`ar-${profile.id}`,existingAccount=await db.prepare("SELECT credit_limit FROM ar_accounts WHERE id=?").bind(arAccountId).first<{credit_limit:number}>(),accountBalance=await db.prepare("SELECT COALESCE(SUM(debit-credit),0) balance FROM ar_ledger_entries WHERE ar_account_id=?").bind(arAccountId).first<{balance:number}>(),creditLimit=existingAccount?Number(existingAccount.credit_limit):Number(body.creditLimit||0),amount=roundMoney(Number(window.balance));if(creditLimit>0&&Number(accountBalance?.balance??0)+amount>creditLimit)return Response.json({error:"AR 신용 한도를 초과합니다."},{status:409});
      const base=Number(window.net_total)+Number(window.tax_total)+Number(window.service_total),ratio=base>0?amount/base:1,subtotal=roundMoney(Number(window.net_total)*ratio),tax=roundMoney(Number(window.tax_total)*ratio),service=roundMoney(amount-subtotal-tax),invoiceId=crypto.randomUUID(),paymentId=crypto.randomUUID(),invoiceNo=`AR-${businessDate.replaceAll('-','')}-${Math.floor(1000+Math.random()*9000)}`;
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO ar_accounts VALUES (?, 'prop-seoul', ?, ?, ?, ?, 'ACTIVE', ?, ?)").bind(arAccountId,profile.id,String(profile.external_id||profile.id),String(profile.name),creditLimit,now,now),
        db.prepare("INSERT INTO ar_invoices VALUES (?, 'prop-seoul', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)").bind(invoiceId,arAccountId,window.reservation_id,window.id,invoiceNo,businessDate,dueDate,subtotal,tax,service,amount,now,actor),
        db.prepare("INSERT INTO ar_ledger_entries VALUES (?, 'prop-seoul', ?, ?, 'INVOICE', ?, 0, ?, NULL, ?, ?, ?, NULL)").bind(crypto.randomUUID(),arAccountId,invoiceId,amount,businessDate,`Folio transfer ${invoiceNo}`,now,actor),
        db.prepare("INSERT INTO folio_entries VALUES (?, 'prop-seoul', ?, 'PAYMENT', 'DIRECT_BILL', ?, ?, 'DIRECT_BILL', ?, ?, ?, NULL)").bind(paymentId,window.reservation_id,`AR 이관 · ${invoiceNo}`,amount,businessDate,now,actor),
        db.prepare("INSERT INTO folio_entry_details VALUES (?, 'prop-seoul', ?, ?, ?, 0, 0, 'KRW', NULL, ?, ?)").bind(paymentId,window.reservation_id,window.id,amount,`AR:${invoiceNo}`,now),
        db.prepare("UPDATE folio_windows SET status='TRANSFERRED',payee_type='COMPANY',payee_account_profile_id=?,closed_at=? WHERE id=? AND status='OPEN'").bind(profile.id,now,window.id),
        db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'TRANSFER_FOLIO_TO_AR', 'ar_invoice', ?, NULL, ?, ?)").bind(crypto.randomUUID(),actor,invoiceId,JSON.stringify({invoiceNo,amount,windowId:window.id,accountProfileId:profile.id}),now),
        db.prepare("INSERT INTO outbox_events VALUES (?, 'prop-seoul', 'ar.invoice_issued', 'ar_invoice', ?, ?, 'PENDING', 0, ?, NULL)").bind(crypto.randomUUID(),invoiceId,JSON.stringify({invoiceId,invoiceNo,amount}),now),
      ]);
    } else if (body.action === "post_ar_payment") {
      const invoice=await db.prepare("SELECT i.*,COALESCE(SUM(l.debit-l.credit),0) balance FROM ar_invoices i LEFT JOIN ar_ledger_entries l ON l.invoice_id=i.id WHERE i.id=? GROUP BY i.id").bind(body.invoiceId).first<Record<string,unknown>>(),amount=roundMoney(Number(body.amount)),method=body.method||"BANK_TRANSFER";if(!invoice||!(amount>0)||amount>Number(invoice.balance)+0.001)return Response.json({error:"AR 청구서 잔액 안에서 수납 금액을 입력하세요."},{status:409});
      const cashier=await db.prepare("SELECT id FROM cashier_sessions WHERE property_id='prop-seoul' AND actor=? AND status='OPEN'").bind(actor).first();if(!cashier)return Response.json({error:"AR 수납 전 캐셔 세션을 개시하세요."},{status:409}); const paid=amount>=Number(invoice.balance)-0.001;
      await db.batch([db.prepare("INSERT INTO ar_ledger_entries VALUES (?, 'prop-seoul', ?, ?, 'PAYMENT', 0, ?, ?, ?, ?, ?, ?, NULL)").bind(crypto.randomUUID(),invoice.ar_account_id,invoice.id,amount,businessDate,method,`AR receipt ${invoice.invoice_no}`,now,actor),...(paid?[db.prepare("UPDATE ar_invoices SET status='PAID' WHERE id=? AND status='OPEN'").bind(invoice.id)]:[]),db.prepare("INSERT INTO audit_logs VALUES (?, 'prop-seoul', ?, 'POST_AR_PAYMENT', 'ar_invoice', ?, ?, ?, ?)").bind(crypto.randomUUID(),actor,String(invoice.id),JSON.stringify({balance:invoice.balance}),JSON.stringify({amount,method,status:paid?'PAID':'OPEN'}),now)]);
    } else if (body.action === "housekeeping") {
      const status = body.status === "INSPECTED" ? "INSPECTED" : "CLEAN";
      await db.batch([
        db.prepare("UPDATE rooms SET housekeeping_status=?, version=version+1 WHERE id=?").bind(status,body.roomId),
        db.prepare("UPDATE housekeeping_tasks SET status='DONE', updated_at=? WHERE room_id=? AND business_date=?").bind(now,body.roomId,businessDate),
        db.prepare("INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)").bind(crypto.randomUUID(),"prop-seoul",actor,"HOUSEKEEPING_COMPLETE","room",body.roomId,JSON.stringify({housekeepingStatus:status}),now),
        ...(idempotencyKey ? [db.prepare("INSERT INTO idempotency_keys VALUES (?, 'prop-seoul', ?, ?, ?)").bind(idempotencyKey,body.action,actor,now)] : []),
      ]);
    } else return Response.json({error:"지원하지 않는 작업입니다."},{status:400});
    invalidateSnapshots();
    return Response.json(await snapshot(db, principal));
  } catch (error) {
    const message=error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    if(error instanceof PmsExtendedError)return Response.json({error:error.message},{status:error.status});
    if (message.includes("room_night_uq") || message.includes("reservation_nights.property_id")) return Response.json({error:"선택한 객실은 해당 일정에 이미 예약되어 있습니다. 다른 객실을 선택하세요."},{status:409});
    if (message.includes("reservation_transition_from_uq") || message.includes("reservation_transitions.property_id")) return Response.json({error:"다른 작업자가 이미 이 예약의 상태를 변경했습니다. 화면을 새로고침해 확인하세요."},{status:409});
    if (message.includes("reservation_mutation_version_uq") || message.includes("reservation_mutations.property_id")) return Response.json({error:"다른 작업자가 같은 예약 버전을 먼저 변경했습니다. 화면을 새로고침하세요."},{status:409});
    if (message.includes("room type sold out")) return Response.json({error:"선택한 객실 타입은 해당 날짜에 판매 가능한 재고가 없습니다."},{status:409});
    if (message.includes("room type closed")) return Response.json({error:"선택한 객실 타입은 해당 날짜에 판매가 마감되었습니다."},{status:409});
    if (message.includes("reservation_type_night_uq")) return Response.json({error:"예약의 날짜별 재고가 이미 반영되어 있습니다."},{status:409});
    if (message.includes("block inventory sold out")) return Response.json({error:"블록 할당이 하우스 가용 재고를 초과합니다."},{status:409});
    if (message.includes("block allocation exhausted")) return Response.json({error:"선택한 날짜의 블록 가용 객실이 모두 픽업되었습니다."},{status:409});
    if (message.includes("block_pickup_entry_date_uq") || message.includes("block_pickup_nights.rooming_entry_id")) return Response.json({error:"다른 작업자가 이미 이 rooming list 항목을 픽업했습니다."},{status:409});
    if (message.includes("business_block_code_uq") || message.includes("business_blocks.property_id")) return Response.json({error:"이미 사용 중인 블록 코드입니다."},{status:409});
    if (message.includes("account_profile_external_uq") || message.includes("account_profiles.property_id")) return Response.json({error:"같은 유형과 외부 ID의 프로필이 이미 있습니다."},{status:409});
    if (message.includes("invalid folio window")) return Response.json({error:"열린 폴리오 창을 찾지 못했습니다."},{status:409});
    if (message.includes("invalid folio entry") || message.includes("invalid folio detail")) return Response.json({error:"전표 금액·세금 구성 또는 대상 폴리오가 올바르지 않습니다."},{status:409});
    if (message.includes("folio_window_reservation_no_uq")) return Response.json({error:"다른 작업자가 같은 폴리오 창 번호를 먼저 만들었습니다."},{status:409});
    if (message.includes("ar_invoice_no_uq")) return Response.json({error:"청구서 번호가 충돌했습니다. 다시 시도하세요."},{status:409});
    if (message.includes("ar ledger entries are immutable") || message.includes("folio details are immutable")) return Response.json({error:"확정 원장은 수정·삭제할 수 없습니다. 반대전표를 사용하세요."},{status:409});
    if (message.includes("channel_connection_provider_property_uq") || message.includes("channel_connections.property_id")) return Response.json({error:"같은 채널과 외부 호텔 ID의 연결이 이미 있습니다."},{status:409});
    if (message.includes("channel_mapping_external_uq") || message.includes("channel_mappings.connection_id")) return Response.json({error:"같은 외부 객실·요금 매핑이 이미 있습니다."},{status:409});
    if (message.includes("stale channel revision")) return Response.json({error:"이미 처리한 revision보다 오래된 채널 메시지입니다."},{status:409});
    if (message.includes("integration attempts are immutable")) return Response.json({error:"연동 시도 원장은 수정·삭제할 수 없습니다."},{status:409});
    if (message.includes("pay or void accrued settlements")) return Response.json({error:"정산 대기 건을 입금·지급 완료 또는 무효 처리한 뒤 계약 유형과 수수료율을 변경하세요."},{status:409});
    if (message.includes("accounting journal lines are immutable") || message.includes("accounting journal entries are immutable")) return Response.json({error:"확정 회계 원장은 수정·삭제할 수 없습니다. 반대전표를 생성하세요."},{status:409});
    return Response.json({error:message},{status:500});
  }
}
