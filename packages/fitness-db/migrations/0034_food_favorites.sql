CREATE TABLE `food_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`food_item_id` text,
	`name` text NOT NULL,
	`quantity_grams` real,
	`quantity_unit` text,
	`quantity_amount` real,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `food_favorites_user_created_idx` ON `food_favorites` (`user_id`,`created_at`);
