CREATE TABLE `exercise_machine_settings` (
	`user_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `exercise_id`)
);
--> statement-breakpoint
CREATE INDEX `exercise_machine_settings_exercise_idx` ON `exercise_machine_settings` (`exercise_id`);