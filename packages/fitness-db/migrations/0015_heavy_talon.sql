CREATE TABLE `food_items` (
	`id` text PRIMARY KEY NOT NULL,
	`upc` text,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`serving_grams` real,
	`kcal_per_100g` real NOT NULL,
	`protein_per_100g` real NOT NULL,
	`carbs_per_100g` real NOT NULL,
	`fat_per_100g` real NOT NULL,
	`raw` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `food_items_upc_uq` ON `food_items` (`upc`);--> statement-breakpoint
CREATE INDEX `food_items_name_idx` ON `food_items` (`name`);--> statement-breakpoint
CREATE TABLE `food_log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`logged_at` integer NOT NULL,
	`food_item_id` text,
	`name` text NOT NULL,
	`quantity_grams` real,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `food_log_entries_user_logged_idx` ON `food_log_entries` (`user_id`,`logged_at`);
-- NOTE: drizzle-kit also emitted `ALTER TABLE workout_sets ADD calories`
-- here because the hand-written 0013 migration never updated the meta
-- snapshot. The column already exists on every deployed DB, so that
-- statement is removed; this generation's snapshot now includes it,
-- ending the drift.