-- Add rate_limits table for planner-api sliding-window rate limiting.
-- Infrastructure table (not domain), additive-only migration.
-- See packages/planner-db/src/schema/rate-limits.ts for full rationale.
CREATE TABLE `rate_limits` (
	`tenant_id` text NOT NULL DEFAULT 'rallypoint',
	`bucket_key` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`count` integer NOT NULL DEFAULT 0,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `bucket_key`, `window_start_ms`)
);
