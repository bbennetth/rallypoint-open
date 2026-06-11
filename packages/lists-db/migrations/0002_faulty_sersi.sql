CREATE TABLE `list_planner_prefs` (
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`show_in_planner` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`list_id`, `user_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
