CREATE TABLE `inventory_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`stay_date` text NOT NULL,
	`sell_limit` integer,
	`closed` integer DEFAULT false NOT NULL,
	`min_stay` integer DEFAULT 1 NOT NULL,
	`close_to_arrival` integer DEFAULT false NOT NULL,
	`close_to_departure` integer DEFAULT false NOT NULL,
	`price_override` real,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_control_type_date_uq` ON `inventory_controls` (`property_id`,`room_type_id`,`stay_date`);--> statement-breakpoint
CREATE INDEX `inventory_control_calendar_idx` ON `inventory_controls` (`property_id`,`stay_date`);--> statement-breakpoint
CREATE TABLE `reservation_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_mutation_version_uq` ON `reservation_mutations` (`property_id`,`reservation_id`,`expected_version`);--> statement-breakpoint
CREATE TABLE `reservation_type_nights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`stay_date` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_type_night_uq` ON `reservation_type_nights` (`reservation_id`,`stay_date`);--> statement-breakpoint
CREATE INDEX `type_night_inventory_idx` ON `reservation_type_nights` (`property_id`,`room_type_id`,`stay_date`);--> statement-breakpoint
CREATE TABLE `room_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`from_room_id` text,
	`to_room_id` text NOT NULL,
	`move_date` text NOT NULL,
	`reason` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_move_reservation_idx` ON `room_moves` (`property_id`,`reservation_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `reservation_type_nights_capacity`
BEFORE INSERT ON `reservation_type_nights`
BEGIN
  SELECT CASE WHEN COALESCE((SELECT `closed` FROM `inventory_controls` WHERE `property_id`=NEW.`property_id` AND `room_type_id`=NEW.`room_type_id` AND `stay_date`=NEW.`stay_date`),0)=1 THEN RAISE(ABORT, 'room type closed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `reservation_type_nights` WHERE `property_id`=NEW.`property_id` AND `room_type_id`=NEW.`room_type_id` AND `stay_date`=NEW.`stay_date`) >= COALESCE((SELECT `sell_limit` FROM `inventory_controls` WHERE `property_id`=NEW.`property_id` AND `room_type_id`=NEW.`room_type_id` AND `stay_date`=NEW.`stay_date`), (SELECT COUNT(*) FROM `rooms` WHERE `property_id`=NEW.`property_id` AND `room_type_id`=NEW.`room_type_id` AND `housekeeping_status`<>'OUT_OF_SERVICE')) THEN RAISE(ABORT, 'room type sold out') END;
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_controls_validate_insert`
BEFORE INSERT ON `inventory_controls`
WHEN NEW.`sell_limit` < 0 OR NEW.`min_stay` < 1 OR NEW.`price_override` < 0
BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END;
--> statement-breakpoint
CREATE TRIGGER `inventory_controls_validate_update`
BEFORE UPDATE ON `inventory_controls`
WHEN NEW.`sell_limit` < 0 OR NEW.`min_stay` < 1 OR NEW.`price_override` < 0
BEGIN SELECT RAISE(ABORT, 'invalid inventory control'); END;
