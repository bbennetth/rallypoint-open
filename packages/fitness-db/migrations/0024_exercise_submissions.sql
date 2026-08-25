CREATE TABLE `exercise_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`admin_note` text,
	`global_exercise_id` text,
	`migration_status` text DEFAULT 'none' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer,
	`migrated_at` integer
);
--> statement-breakpoint
CREATE INDEX `exercise_submissions_user_idx` ON `exercise_submissions` (`user_id`);--> statement-breakpoint
CREATE INDEX `exercise_submissions_status_idx` ON `exercise_submissions` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_submissions_pending_exercise_uq` ON `exercise_submissions` (`exercise_id`) WHERE "exercise_submissions"."status" = 'pending';