CREATE TABLE `group_member_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`layer` text NOT NULL,
	`x_pct` real NOT NULL,
	`y_pct` real NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_member_locations_group_user_idx` ON `group_member_locations` (`group_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `rallies` ADD `pin_layer` text;--> statement-breakpoint
ALTER TABLE `rallies` ADD `pin_x_pct` real;--> statement-breakpoint
ALTER TABLE `rallies` ADD `pin_y_pct` real;