CREATE TABLE `rate_limits` (
	`tenant_id` text NOT NULL DEFAULT 'rallypoint',
	`bucket_key` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`count` integer NOT NULL DEFAULT 0,
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY(`tenant_id`, `bucket_key`, `window_start_ms`)
);
