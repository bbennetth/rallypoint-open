CREATE TABLE `push_subscriptions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_success_at` integer
);
--> statement-breakpoint
CREATE INDEX `planner_push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `scheduled_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text NOT NULL,
	`fire_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`sent_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planner_scheduled_notifications_dedupe_idx` ON `scheduled_notifications` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `planner_scheduled_notifications_fire_at_idx` ON `scheduled_notifications` (`fire_at`);