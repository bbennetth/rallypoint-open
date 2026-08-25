CREATE TABLE `food_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`upc` text NOT NULL,
	`private_food_item_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`serving_grams` real NOT NULL,
	`serving_quantity` real NOT NULL,
	`serving_unit` text NOT NULL,
	`is_liquid` integer NOT NULL,
	`kcal_per_100g` real NOT NULL,
	`protein_per_100g` real NOT NULL,
	`carbs_per_100g` real NOT NULL,
	`fat_per_100g` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`admin_note` text,
	`global_food_item_id` text,
	`migration_status` text DEFAULT 'none' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer,
	`migrated_at` integer
);
--> statement-breakpoint
CREATE INDEX `food_submissions_user_idx` ON `food_submissions` (`user_id`);--> statement-breakpoint
CREATE INDEX `food_submissions_status_idx` ON `food_submissions` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `food_submissions_pending_upc_uq` ON `food_submissions` (`upc`) WHERE "food_submissions"."status" = 'pending';