-- Additive migration: idempotency key for personal-event create retries
-- (repo-wide "offline create retries must be idempotent" fix; mirrors
-- money-api's expense/settlement `ref` — see 0002_settlement_ref.sql in
-- packages/money-db/migrations).
--
-- Adds a nullable `ref` column + a partial unique index on
-- (owner_user_id, ref) WHERE ref IS NOT NULL.
--
-- An offline create op carries a stable client-generated `tmpId`
-- (`tmp_<uuid>`) across retries and sends it as `ref` on personal-event
-- create. A retry that lands after the original commit (e.g. the
-- response timed out) finds the existing row via this index and returns
-- it instead of inserting a duplicate. Events without a ref behave as
-- before (un-keyed, duplicates allowed) — opt-in.
--
-- Expand-safe: column is NULLABLE (no DEFAULT needed; existing rows get
-- NULL). Partial unique index ignores NULL rows so the historical data
-- set isn't affected. Scoped to owner_user_id (not tenant_id) — personal
-- events are private to a single owner, so ref is a per-owner key.

ALTER TABLE `events` ADD COLUMN `ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_owner_ref_uq` ON `events` (`owner_user_id`, `ref`) WHERE `ref` IS NOT NULL;
