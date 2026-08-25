-- Additive migration: idempotency key for offline-retry-safe creates
-- (repo-wide "offline create retries must be idempotent" fix, mirrors
-- money-db's 0002_settlement_ref.sql). Adds a nullable `ref` column to
-- both `list_items` and `list_item_series`, each with its own partial
-- unique index scoped to (list_id, ref) WHERE ref IS NOT NULL.
--
-- A client can pass `ref` (e.g. a stable client `tmp_<uuid>`) on a
-- create. A retry with the same (list_id, ref) tuple finds the row
-- that was already created and returns it instead of inserting a
-- duplicate. Items/series without a ref behave as before (un-keyed,
-- duplicates allowed) — opt-in.
--
-- Expand-safe: both columns are NULLABLE (no DEFAULT needed; existing
-- rows get NULL). The partial unique indexes ignore NULL rows so the
-- historical data set isn't affected.

ALTER TABLE `list_items` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_items_list_ref_uq` ON `list_items` (`list_id`, `ref`) WHERE `ref` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `list_item_series` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_series_list_ref_uq` ON `list_item_series` (`list_id`, `ref`) WHERE `ref` IS NOT NULL;
