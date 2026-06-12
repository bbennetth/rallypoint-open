ALTER TABLE `events` ADD `features` text;--> statement-breakpoint
ALTER TABLE `event_sessions` ADD `stage_id` text REFERENCES `event_stages`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `groups` ADD `short_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_short_code_idx` ON `groups` (`short_code`);
