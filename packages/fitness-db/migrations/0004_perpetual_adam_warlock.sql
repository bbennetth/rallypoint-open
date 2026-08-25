CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `metrics_user_kind_recorded_idx` ON `metrics` (`user_id`,`kind`,`recorded_at`);