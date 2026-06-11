CREATE TABLE `ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `money_ledgers_scope_idx` ON `ledgers` (`tenant_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `money_ledgers_owner_idx` ON `ledgers` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `ledger_members` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `money_ledger_members_ledger_user_uq` ON `ledger_members` (`ledger_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `money_ledger_members_user_idx` ON `ledger_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `ledger_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `ledger_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `ledger_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `money_ledger_group_members_group_user_uq` ON `ledger_group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `money_ledger_group_members_user_idx` ON `ledger_group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `ledger_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`invited_email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `money_ledger_invites_code_hash_idx` ON `ledger_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `money_ledger_invites_ledger_idx` ON `ledger_invites` (`ledger_id`);--> statement-breakpoint
CREATE TABLE `ledger_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `money_ledger_activity_ledger_created_idx` ON `ledger_activity` (`ledger_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `money_expense_categories_ledger_name_uq` ON `expense_categories` (`ledger_id`,`name`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`paid_by_user_id` text NOT NULL,
	`total_cents` integer NOT NULL,
	`description` text NOT NULL,
	`split_mode` text NOT NULL,
	`category_id` text,
	`ref` text,
	`receipt_object_key` text,
	`receipt_content_type` text,
	`receipt_bytes` integer,
	`spent_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `money_expenses_ledger_spent_idx` ON `expenses` (`ledger_id`,`spent_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `money_expenses_ledger_ref_uq` ON `expenses` (`ledger_id`,`ref`) WHERE "expenses"."ref" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `expense_splits` (
	`expense_id` text NOT NULL,
	`user_id` text NOT NULL,
	`amount_cents` integer,
	`share_weight` integer,
	PRIMARY KEY(`expense_id`, `user_id`),
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`settled_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `money_settlements_ledger_settled_idx` ON `settlements` (`ledger_id`,`settled_at`);--> statement-breakpoint
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
CREATE INDEX `money_sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `money_sessions_expires_idx` ON `sessions` (`absolute_expires_at`);