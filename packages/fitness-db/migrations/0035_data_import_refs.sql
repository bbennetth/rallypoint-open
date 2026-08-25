-- Additive migration: extend the offline-create `ref` idempotency key
-- (0032_create_refs.sql) to the four remaining user-owned tables that
-- the data export/import (backup–restore) has to dedupe on.
--
-- Import is merge-with-dedupe: re-running the same archive must be a
-- no-op, which needs a stable per-row key that survives the id
-- remapping an import necessarily does. Rows are exported with
-- `ref = row.ref ?? row.id`, so a restored row carries the source
-- row's identity and a second import of the same archive finds it.
--
-- Only tables with NO usable natural key get a ref. food_items is
-- deliberately absent: private rows are already uniquely keyed by
-- (owner_user_id, lower(name)) via food_items_owner_custom_name_uq,
-- and a second key that could disagree with the one the DB enforces
-- would be a bug source, not a safeguard. Child rows (workout_sets,
-- recipe_ingredients, prepared_meal_ingredients) ride on their
-- parent's dedupe and need no key of their own.
--
-- Expand-safe, same shape as 0032: every `ref` is NULLABLE (existing
-- rows get NULL, no DEFAULT needed) and every index is partial on
-- `ref IS NOT NULL`, so old Worker isolates still serving traffic
-- during rollout see no behavior change.

ALTER TABLE `food_log_entries` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_food_log_entries_user_ref_uq` ON `food_log_entries` (`user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `progress_photos` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_progress_photos_user_ref_uq` ON `progress_photos` (`user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `recipes` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_recipes_owner_ref_uq` ON `recipes` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `prepared_meals` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_prepared_meals_owner_ref_uq` ON `prepared_meals` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
