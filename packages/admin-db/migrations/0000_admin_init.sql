CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rpid_bearer_ciphertext` text NOT NULL,
	`rpid_bearer_nonce` text NOT NULL,
	`rpid_bearer_key_version` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`ip_hash` text NOT NULL,
	`ua_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `admin_sessions_expires_idx` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`bucket_key` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `bucket_key`, `window_start_ms`)
);
