CREATE TABLE `exercise_favorites` (
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `exercise_id`)
);
--> statement-breakpoint
CREATE INDEX `exercise_favorites_exercise_idx` ON `exercise_favorites` (`exercise_id`);