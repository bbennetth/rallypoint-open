CREATE TABLE `event_planner_prefs` (
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`show_in_planner` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
