CREATE TABLE `ari_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`mapping_id` text NOT NULL,
	`stay_date` text NOT NULL,
	`revision` integer NOT NULL,
	`available` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`min_stay` integer DEFAULT 1 NOT NULL,
	`close_to_arrival` integer DEFAULT false NOT NULL,
	`close_to_departure` integer DEFAULT false NOT NULL,
	`rate` real NOT NULL,
	`currency` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ari_update_revision_uq` ON `ari_updates` (`mapping_id`,`stay_date`,`revision`);--> statement-breakpoint
CREATE INDEX `ari_update_dispatch_idx` ON `ari_updates` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_property_id` text NOT NULL,
	`name` text NOT NULL,
	`environment` text DEFAULT 'SANDBOX' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`last_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_connection_provider_property_uq` ON `channel_connections` (`property_id`,`provider`,`external_property_id`);--> statement-breakpoint
CREATE INDEX `channel_connection_status_idx` ON `channel_connections` (`property_id`,`status`);--> statement-breakpoint
CREATE TABLE `channel_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`external_room_type_id` text NOT NULL,
	`rate_plan` text NOT NULL,
	`external_rate_plan_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_mapping_external_uq` ON `channel_mappings` (`connection_id`,`external_room_type_id`,`external_rate_plan_id`);--> statement-breakpoint
CREATE INDEX `channel_mapping_internal_idx` ON `channel_mappings` (`property_id`,`room_type_id`,`rate_plan`);--> statement-breakpoint
CREATE TABLE `channel_reservation_links` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_reservation_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`last_revision` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_reservation_external_uq` ON `channel_reservation_links` (`connection_id`,`external_reservation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_reservation_internal_uq` ON `channel_reservation_links` (`connection_id`,`reservation_id`);--> statement-breakpoint
CREATE TABLE `inbound_channel_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider` text NOT NULL,
	`message_id` text NOT NULL,
	`event_type` text NOT NULL,
	`external_reservation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reservation_id` text,
	`last_error` text,
	`received_at` text NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_channel_message_uq` ON `inbound_channel_messages` (`connection_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `inbound_channel_dlq_idx` ON `inbound_channel_messages` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `integration_delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`direction` text NOT NULL,
	`provider` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`error_code` text,
	`error_message` text,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_attempt_aggregate_idx` ON `integration_delivery_attempts` (`aggregate_type`,`aggregate_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `integration_attempt_failure_idx` ON `integration_delivery_attempts` (`status`,`created_at`);