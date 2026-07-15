CREATE TABLE `account_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`external_id` text,
	`email` text,
	`phone` text,
	`negotiated_rate_code` text,
	`credit_status` text DEFAULT 'CASH' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_profile_external_uq` ON `account_profiles` (`property_id`,`type`,`external_id`);--> statement-breakpoint
CREATE INDEX `account_profile_search_idx` ON `account_profiles` (`property_id`,`type`,`name`);--> statement-breakpoint
CREATE TABLE `block_inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`block_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`stay_date` text NOT NULL,
	`original_rooms` integer NOT NULL,
	`current_rooms` integer NOT NULL,
	`picked_up` integer DEFAULT 0 NOT NULL,
	`rate` real NOT NULL,
	`cutoff_date` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `block_inventory_type_date_uq` ON `block_inventory` (`block_id`,`room_type_id`,`stay_date`);--> statement-breakpoint
CREATE INDEX `block_inventory_house_idx` ON `block_inventory` (`property_id`,`room_type_id`,`stay_date`);--> statement-breakpoint
CREATE TABLE `block_pickup_nights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`property_id` text NOT NULL,
	`block_id` text NOT NULL,
	`rooming_entry_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`stay_date` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `block_pickup_entry_date_uq` ON `block_pickup_nights` (`rooming_entry_id`,`stay_date`);--> statement-breakpoint
CREATE INDEX `block_pickup_block_date_idx` ON `block_pickup_nights` (`block_id`,`room_type_id`,`stay_date`);--> statement-breakpoint
CREATE TABLE `business_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`account_profile_id` text,
	`group_profile_id` text,
	`arrival_date` text NOT NULL,
	`departure_date` text NOT NULL,
	`status` text NOT NULL,
	`reservation_method` text NOT NULL,
	`deduct_inventory` integer DEFAULT true NOT NULL,
	`cutoff_date` text,
	`currency` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`cutoff_processed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_block_code_uq` ON `business_blocks` (`property_id`,`code`);--> statement-breakpoint
CREATE INDEX `business_block_dates_idx` ON `business_blocks` (`property_id`,`arrival_date`,`departure_date`,`status`);--> statement-breakpoint
CREATE TABLE `rooming_list_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`block_id` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text,
	`phone` text,
	`arrival_date` text NOT NULL,
	`departure_date` text NOT NULL,
	`room_type_id` text NOT NULL,
	`status` text NOT NULL,
	`reservation_id` text,
	`rate` real NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooming_list_block_idx` ON `rooming_list_entries` (`block_id`,`status`,`last_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `rooming_list_reservation_uq` ON `rooming_list_entries` (`reservation_id`);