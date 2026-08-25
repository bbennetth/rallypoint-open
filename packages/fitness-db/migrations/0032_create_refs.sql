-- Additive migration: offline-create idempotency key for the six
-- fitness create routes (repo-wide "offline create retries must be
-- idempotent" fix — mirrors money-db's expenses.ref /
-- 0002_settlement_ref.sql pattern). Adds a nullable `ref` column + a
-- partial unique index scoped to each table's owning entity, WHERE
-- ref IS NOT NULL.
--
-- An offline client stamps a stable tmpId (`tmp_<uuid>`) on a create
-- op and resends it verbatim on retry. The server dedups on
-- (scope, ref): a retry that lands after the first attempt already
-- committed finds the existing row and replays it instead of
-- inserting a duplicate. Rows without a ref behave as before
-- (un-keyed, duplicates allowed) — opt-in, exactly like money's
-- settlement/expense refs.
--
-- Expand-safe: every `ref` column is NULLABLE (no DEFAULT needed —
-- existing rows get NULL) and every index is partial, so the
-- historical data set is unaffected and old Worker isolates reading
-- pre-migration rows see no behavior change.

ALTER TABLE `workouts` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_workouts_user_ref_uq` ON `workouts` (`user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `metrics` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_metrics_user_ref_uq` ON `metrics` (`user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `exercises` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_exercises_owner_ref_uq` ON `exercises` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `wod_templates` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_wod_templates_owner_ref_uq` ON `wod_templates` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `training_plans` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_training_plans_owner_ref_uq` ON `training_plans` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `training_plan_items` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `fitness_plan_items_plan_ref_uq` ON `training_plan_items` (`plan_id`, `ref`) WHERE `ref` IS NOT NULL;
