CREATE TABLE `ar_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`account_profile_id` text NOT NULL,
	`account_no` text NOT NULL,
	`name` text NOT NULL,
	`credit_limit` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ar_account_profile_uq` ON `ar_accounts` (`property_id`,`account_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ar_account_no_uq` ON `ar_accounts` (`property_id`,`account_no`);--> statement-breakpoint
CREATE TABLE `ar_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`ar_account_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`folio_window_id` text NOT NULL,
	`invoice_no` text NOT NULL,
	`issued_date` text NOT NULL,
	`due_date` text NOT NULL,
	`subtotal` real NOT NULL,
	`tax_amount` real NOT NULL,
	`service_amount` real NOT NULL,
	`total` real NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ar_invoice_no_uq` ON `ar_invoices` (`property_id`,`invoice_no`);--> statement-breakpoint
CREATE INDEX `ar_invoice_account_due_idx` ON `ar_invoices` (`ar_account_id`,`status`,`due_date`);--> statement-breakpoint
CREATE TABLE `ar_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`ar_account_id` text NOT NULL,
	`invoice_id` text,
	`kind` text NOT NULL,
	`debit` real DEFAULT 0 NOT NULL,
	`credit` real DEFAULT 0 NOT NULL,
	`business_date` text NOT NULL,
	`payment_method` text,
	`memo` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`reverses_entry_id` text
);
--> statement-breakpoint
CREATE INDEX `ar_ledger_account_idx` ON `ar_ledger_entries` (`ar_account_id`,`business_date`,`created_at`);--> statement-breakpoint
CREATE INDEX `ar_ledger_invoice_idx` ON `ar_ledger_entries` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `folio_entry_details` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`folio_window_id` text NOT NULL,
	`net_amount` real NOT NULL,
	`tax_amount` real DEFAULT 0 NOT NULL,
	`service_amount` real DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`source_entry_id` text,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folio_detail_window_idx` ON `folio_entry_details` (`folio_window_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `folio_detail_source_idx` ON `folio_entry_details` (`source_entry_id`);--> statement-breakpoint
CREATE TABLE `folio_routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`transaction_code` text NOT NULL,
	`target_window_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folio_routing_reservation_code_uq` ON `folio_routing_rules` (`reservation_id`,`transaction_code`);--> statement-breakpoint
CREATE INDEX `folio_routing_target_idx` ON `folio_routing_rules` (`target_window_id`,`active`);--> statement-breakpoint
CREATE TABLE `folio_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`window_no` integer NOT NULL,
	`name` text NOT NULL,
	`payee_type` text DEFAULT 'GUEST' NOT NULL,
	`payee_account_profile_id` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folio_window_reservation_no_uq` ON `folio_windows` (`reservation_id`,`window_no`);--> statement-breakpoint
CREATE INDEX `folio_window_property_idx` ON `folio_windows` (`property_id`,`status`);--> statement-breakpoint
CREATE TABLE `transaction_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`tax_rate` real DEFAULT 0 NOT NULL,
	`service_rate` real DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_code_property_uq` ON `transaction_codes` (`property_id`,`code`);