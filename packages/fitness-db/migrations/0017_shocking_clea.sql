-- Food quantity units (cups / oz / servings). All expand-only nullable
-- columns: food_items learns the product's declared serving basis
-- (quantity + g/ml + liquid flag, from OFF's structured serving
-- fields); food_log_entries records the unit + amount the user typed,
-- alongside the still-canonical quantity_grams.
-- NOTE: drizzle-kit also diffed workout_sets.incline_pct here because
-- hand-written 0016 never updated the meta snapshot; that statement was
-- removed (the column already exists) and the 0017 snapshot now carries
-- it, healing the drift.
ALTER TABLE `food_items` ADD `serving_quantity` real;--> statement-breakpoint
ALTER TABLE `food_items` ADD `serving_unit` text;--> statement-breakpoint
ALTER TABLE `food_items` ADD `is_liquid` integer;--> statement-breakpoint
ALTER TABLE `food_log_entries` ADD `quantity_unit` text;--> statement-breakpoint
ALTER TABLE `food_log_entries` ADD `quantity_amount` real;
