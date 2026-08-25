CREATE TABLE `prepared_meals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`recipe_id` text,
	`status` text DEFAULT 'cooking' NOT NULL,
	`total_grams` real DEFAULT 0 NOT NULL,
	`total_kcal` real DEFAULT 0 NOT NULL,
	`total_protein_g` real DEFAULT 0 NOT NULL,
	`total_carbs_g` real DEFAULT 0 NOT NULL,
	`total_fat_g` real DEFAULT 0 NOT NULL,
	`grams_remaining` real DEFAULT 0 NOT NULL,
	`servings` real,
	`prepared_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prepared_meals_owner_status_idx` ON `prepared_meals` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `prepared_meal_ingredients` (
	`id` text PRIMARY KEY NOT NULL,
	`prepared_meal_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`food_item_id` text,
	`grams_added` real NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prepared_meal_ingredients_meal_idx` ON `prepared_meal_ingredients` (`prepared_meal_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`yield_grams` real,
	`servings` real,
	`total_kcal` real DEFAULT 0 NOT NULL,
	`total_protein_g` real DEFAULT 0 NOT NULL,
	`total_carbs_g` real DEFAULT 0 NOT NULL,
	`total_fat_g` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipes_owner_idx` ON `recipes` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `recipe_ingredients` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`food_item_id` text,
	`grams` real NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_ingredients_recipe_idx` ON `recipe_ingredients` (`recipe_id`);--> statement-breakpoint
ALTER TABLE `food_log_entries` ADD `prepared_meal_id` text;