CREATE TABLE `report_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`report_key` text NOT NULL,
	`format` text NOT NULL,
	`filters_json` text NOT NULL,
	`row_count` integer NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `report_export_actor_idx` ON `report_exports` (`property_id`,`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `report_export_status_idx` ON `report_exports` (`property_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `room_types` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_types` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `active` integer DEFAULT true NOT NULL;