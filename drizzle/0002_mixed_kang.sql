CREATE TABLE `cashier_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`actor` text NOT NULL,
	`business_date` text NOT NULL,
	`status` text NOT NULL,
	`opening_amount` real NOT NULL,
	`expected_amount` real,
	`counted_amount` real,
	`variance` real,
	`opened_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `cashier_open_idx` ON `cashier_sessions` (`property_id`,`status`,`actor`);--> statement-breakpoint
CREATE UNIQUE INDEX `cashier_actor_open_uq` ON `cashier_sessions` (`property_id`,`actor`) WHERE "cashier_sessions"."status" = 'OPEN';--> statement-breakpoint
CREATE TABLE `night_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`status` text NOT NULL,
	`blockers_json` text NOT NULL,
	`summary_json` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`completed_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `night_audit_property_date_uq` ON `night_audits` (`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_property_email_uq` ON `role_assignments` (`property_id`,`email`);