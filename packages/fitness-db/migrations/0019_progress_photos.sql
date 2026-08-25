CREATE TABLE `progress_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`pose` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `progress_photos_user_taken_idx` ON `progress_photos` (`user_id`,`taken_at`);--> statement-breakpoint
CREATE INDEX `progress_photos_user_pose_taken_idx` ON `progress_photos` (`user_id`,`pose`,`taken_at`);