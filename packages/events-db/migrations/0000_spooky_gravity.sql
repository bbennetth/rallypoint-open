CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`owner_user_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`start_date` text,
	`end_date` text,
	`timezone` text NOT NULL,
	`location_label` text,
	`location_lat` real,
	`location_lng` real,
	`privacy_mode` text DEFAULT 'unlisted' NOT NULL,
	`public_page_config` text,
	`scope_type` text DEFAULT 'personal' NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_tenant_slug_idx` ON `events` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `events_owner_idx` ON `events` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `events_personal_idx` ON `events` (`tenant_id`,`scope_type`,`owner_user_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `event_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_members_event_user_idx` ON `event_members` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `event_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`invited_email` text,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_invites_code_hash_idx` ON `event_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `event_invites_event_idx` ON `event_invites` (`event_id`);--> statement-breakpoint
CREATE TABLE `event_attendees` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_attendees_event_user_idx` ON `event_attendees` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `event_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`quantity` integer,
	`sold_count` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_tickets_sold_lte_quantity_ck" CHECK("event_tickets"."quantity" IS NULL OR "event_tickets"."sold_count" <= "event_tickets"."quantity")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_tickets_event_name_idx` ON `event_tickets` (`event_id`,`name`);--> statement-breakpoint
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
CREATE INDEX `events_sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `events_sessions_expires_idx` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE TABLE `event_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_activity_event_created_idx` ON `event_activity` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `event_purge_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`purged_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`days_after_grace` integer NOT NULL,
	`objects_reaped` integer DEFAULT 0 NOT NULL,
	`objects_failed` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_purge_log_purged_at_idx` ON `event_purge_log` (`purged_at`);--> statement-breakpoint
CREATE INDEX `event_purge_log_event_idx` ON `event_purge_log` (`event_id`);--> statement-breakpoint
CREATE TABLE `event_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_stages_event_name_idx` ON `event_stages` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `event_days` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`day_label` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_days_event_label_idx` ON `event_days` (`event_id`,`day_label`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_days_event_date_idx` ON `event_days` (`event_id`,`date`);--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`soundcloud` text,
	`spotify` text,
	`apple_music` text,
	`youtube_music` text,
	`instagram` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_lower_name_idx` ON `artists` (lower("name"));--> statement-breakpoint
CREATE TABLE `event_artists` (
	`event_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`day_id` text NOT NULL,
	`stage_id` text,
	`tier` text,
	`genre` text,
	`start_time` text,
	`end_time` text,
	`display_name` text,
	PRIMARY KEY(`event_id`, `artist_id`, `day_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`day_id`) REFERENCES `event_days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `event_stages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `event_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`day_id` text,
	`start_time` text,
	`end_time` text,
	`category` text,
	`host` text,
	`approval_status` text DEFAULT 'approved' NOT NULL,
	`visibility` text DEFAULT 'group' NOT NULL,
	`group_id` text,
	`shared_with` text,
	`created_by_user_id` text NOT NULL,
	`submitted_by_user_id` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `event_days`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `event_sessions_event_day_idx` ON `event_sessions` (`event_id`,`day_id`);--> statement-breakpoint
CREATE TABLE `event_maps` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`layer` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width_px` integer NOT NULL,
	`height_px` integer NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_maps_event_layer_idx` ON `event_maps` (`event_id`,`layer`);--> statement-breakpoint
CREATE TABLE `event_pois` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`map_id` text,
	`category_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`x_pct` real NOT NULL,
	`y_pct` real NOT NULL,
	`lat` real,
	`lng` real,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`map_id`) REFERENCES `event_maps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `event_pois_event_map_idx` ON `event_pois` (`event_id`,`map_id`);--> statement-breakpoint
CREATE TABLE `event_no_go_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`map_id` text NOT NULL,
	`polygon` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`map_id`) REFERENCES `event_maps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_no_go_zones_event_map_idx` ON `event_no_go_zones` (`event_id`,`map_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`start_date` text,
	`end_date` text,
	`join_code_hash` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_event_name_idx` ON `groups` (`event_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `groups_join_code_hash_idx` ON `groups` (`join_code_hash`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_group_user_idx` ON `group_members` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `group_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`invited_email` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_invites_code_hash_idx` ON `group_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `group_invites_group_idx` ON `group_invites` (`group_id`);--> statement-breakpoint
CREATE TABLE `rallies` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`day_id` text,
	`start_time` text,
	`poi_id` text,
	`location_label` text,
	`lat` real,
	`lng` real,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `event_days`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`poi_id`) REFERENCES `event_pois`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rallies_group_idx` ON `rallies` (`group_id`);--> statement-breakpoint
CREATE TABLE `rally_attendees` (
	`id` text PRIMARY KEY NOT NULL,
	`rally_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`responded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`rally_id`) REFERENCES `rallies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rally_attendees_rally_user_idx` ON `rally_attendees` (`rally_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_group_created_idx` ON `chat_messages` (`group_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `event_weather` (
	`event_id` text PRIMARY KEY NOT NULL,
	`forecast` text,
	`air_quality` text,
	`fetched_lat` text,
	`fetched_lng` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`error_at` integer,
	`error_code` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `event_set_stars` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`day_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`, `artist_id`, `day_id`),
	FOREIGN KEY (`event_id`,`artist_id`,`day_id`) REFERENCES `event_artists`(`event_id`,`artist_id`,`day_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `event_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`reason` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_snapshots_event_kind_idx` ON `event_snapshots` (`event_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `personal_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`file_name` text,
	`uploaded_by_user_id` text NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_tickets_event_idx` ON `personal_tickets` (`event_id`);