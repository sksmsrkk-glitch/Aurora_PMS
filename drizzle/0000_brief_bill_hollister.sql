CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_logs` (`property_id`,`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `folio_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`payment_method` text,
	`business_date` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`reverses_entry_id` text
);
--> statement-breakpoint
CREATE INDEX `folio_reservation_idx` ON `folio_entries` (`reservation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `guests` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text,
	`phone` text,
	`vip_level` text DEFAULT 'NONE' NOT NULL,
	`nationality` text,
	`preferences` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guest_search_idx` ON `guests` (`property_id`,`last_name`,`first_name`);--> statement-breakpoint
CREATE TABLE `housekeeping_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 2 NOT NULL,
	`assignee` text,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hk_board_idx` ON `housekeeping_tasks` (`property_id`,`business_date`,`status`);--> statement-breakpoint
CREATE TABLE `properties` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`timezone` text NOT NULL,
	`currency` text NOT NULL,
	`business_date` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reservation_nights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`room_id` text NOT NULL,
	`stay_date` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_night_uq` ON `reservation_nights` (`property_id`,`room_id`,`stay_date`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`confirmation_no` text NOT NULL,
	`property_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`room_id` text,
	`arrival_date` text NOT NULL,
	`departure_date` text NOT NULL,
	`status` text NOT NULL,
	`adults` integer NOT NULL,
	`children` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`rate_plan` text NOT NULL,
	`nightly_rate` real NOT NULL,
	`eta` text,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `confirmation_uq` ON `reservations` (`property_id`,`confirmation_no`);--> statement-breakpoint
CREATE INDEX `arrival_idx` ON `reservations` (`property_id`,`arrival_date`,`status`);--> statement-breakpoint
CREATE INDEX `room_stay_idx` ON `reservations` (`room_id`,`arrival_date`,`departure_date`);--> statement-breakpoint
CREATE TABLE `room_types` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`base_rate` real NOT NULL,
	`capacity` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_type_code_uq` ON `room_types` (`property_id`,`code`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`number` text NOT NULL,
	`floor` integer NOT NULL,
	`front_desk_status` text NOT NULL,
	`housekeeping_status` text NOT NULL,
	`features` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_number_uq` ON `rooms` (`property_id`,`number`);--> statement-breakpoint
CREATE INDEX `room_status_idx` ON `rooms` (`property_id`,`housekeeping_status`);