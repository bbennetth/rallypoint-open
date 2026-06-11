-- Foreign-key enforcement relies on the D1 platform default
-- `PRAGMA foreign_keys = ON`. D1 and Miniflare (where tests run) enable it
-- by default; this baseline does not (and cannot durably) set it, since a
-- connection-level PRAGMA does not persist across D1's per-statement
-- execution. No cascade is exercised today — lists use soft-delete and
-- there is no hard-purge pruner — so this is a latent reliance, not an
-- active dependency. Revisit (assert or re-document) if a lists hard-purge
-- pruner lands or a non-Miniflare SQLite driver is introduced. See #327.
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`list_type` text NOT NULL,
	`name` text NOT NULL,
	`visibility` text DEFAULT 'all' NOT NULL,
	`color` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `lists_scope_idx` ON `lists` (`tenant_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `lists_created_by_idx` ON `lists` (`created_by`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`assigned_to` text,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`status` text,
	`priority` text,
	`due_date` integer,
	`series_id` text,
	`occurrence_date` text,
	`is_exception` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`custom_fields` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`series_id`) REFERENCES `list_item_series`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `list_items_list_idx` ON `list_items` (`list_id`,`position`);--> statement-breakpoint
CREATE INDEX `list_items_assigned_idx` ON `list_items` (`assigned_to`);--> statement-breakpoint
CREATE INDEX `list_items_status_idx` ON `list_items` (`list_id`,`status`);--> statement-breakpoint
CREATE INDEX `list_items_series_idx` ON `list_items` (`series_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `list_item_series` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`assigned_to` text,
	`priority` text,
	`freq` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`by_day` text,
	`dtstart` text NOT NULL,
	`until` text,
	`count` integer,
	`time_of_day` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_item_series_list_idx` ON `list_item_series` (`list_id`);--> statement-breakpoint
CREATE TABLE `list_field_defs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`list_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`field_type` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`default_value` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_field_defs_list_idx` ON `list_field_defs` (`list_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `list_field_defs_list_key_uq` ON `list_field_defs` (`list_id`,`key`) WHERE "list_field_defs"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `list_views` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_views_list_idx` ON `list_views` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `list_groups` (
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
CREATE TABLE `list_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `list_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_group_members_group_user_uq` ON `list_group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `list_group_members_user_idx` ON `list_group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `list_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_shares_list_user_idx` ON `list_shares` (`list_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `list_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`invited_email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_invites_code_hash_idx` ON `list_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `list_invites_list_idx` ON `list_invites` (`list_id`);--> statement-breakpoint
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
CREATE INDEX `lists_sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `lists_sessions_expires_idx` ON `sessions` (`absolute_expires_at`);