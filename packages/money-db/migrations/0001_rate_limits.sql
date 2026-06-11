-- Additive migration: sliding-window rate-limits table for money-api.
-- Shape mirrors packages/db/src/schema/rate-limits.ts (used by id-api).
-- PK is (tenant_id, bucket_key, window_start_ms) — the atomic upsert
-- path writes INSERT ... ON CONFLICT DO UPDATE against this tuple.

CREATE TABLE `rate_limits` (
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`bucket_key` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `bucket_key`, `window_start_ms`)
);
