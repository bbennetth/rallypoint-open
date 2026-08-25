-- Additive migration: idempotency key for settlements (audit E2 #7).
-- Adds a nullable `ref` column + a partial unique index on
-- (ledger_id, ref) WHERE ref IS NOT NULL.
--
-- A client can pass `ref` on a settlement POST. Retries with the same
-- (ledger_id, ref) tuple find the row that was already created and
-- return it instead of inserting a duplicate. Settlements without a
-- ref behave as before (un-keyed, duplicates allowed) — opt-in.
--
-- Expand-safe: column is NULLABLE (no DEFAULT needed; existing rows
-- get NULL). Partial unique index ignores NULL rows so the historical
-- data set isn't affected.

ALTER TABLE `settlements` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `money_settlements_ledger_ref_uq` ON `settlements` (`ledger_id`, `ref`) WHERE `ref` IS NOT NULL;
