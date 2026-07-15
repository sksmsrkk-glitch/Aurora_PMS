CREATE TABLE `reservation_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_transition_from_uq` ON `reservation_transitions` (`property_id`,`reservation_id`,`from_status`);