CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`username` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`picture_url` text,
	`avatar_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_email_idx` ON `users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE TABLE `auth_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`kind` text NOT NULL,
	`secret_hash` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_methods_user_idx` ON `auth_methods` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_methods_user_kind_unique_idx` ON `auth_methods` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `email_verifications` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_verifications_user_idx` ON `email_verifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_verifications_expires_idx` ON `email_verifications` (`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`event_type` text NOT NULL,
	`user_id` text,
	`ip_hash` text NOT NULL,
	`ua_hash` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_tenant_user_idx` ON `audit_log` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `audit_log_tenant_event_idx` ON `audit_log` (`tenant_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`bucket_key` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `bucket_key`, `window_start_ms`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`parent_session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`ip_hash` text NOT NULL,
	`ua_hash` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id_hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE TABLE `signin_challenges` (
	`challenge_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`code_hmac` text NOT NULL,
	`attempts_remaining` integer DEFAULT 5 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`locked_at` integer,
	`last_code_issued_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signin_challenges_user_idx` ON `signin_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `signin_challenges_expires_idx` ON `signin_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `password_resets_user_idx` ON `password_resets` (`user_id`);--> statement-breakpoint
CREATE INDEX `password_resets_expires_idx` ON `password_resets` (`expires_at`);--> statement-breakpoint
CREATE TABLE `email_changes` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`new_email` text NOT NULL,
	`old_email` text NOT NULL,
	`cancel_token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_changes_user_idx` ON `email_changes` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_changes_cancel_unique_idx` ON `email_changes` (`cancel_token_hash`);--> statement-breakpoint
CREATE INDEX `email_changes_expires_idx` ON `email_changes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sso_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`minting_session_id_hash` text,
	`client` text NOT NULL,
	`return_to_host` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sso_codes_user_created_idx` ON `sso_codes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sso_codes_expires_idx` ON `sso_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `namespace`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
