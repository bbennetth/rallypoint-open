CREATE TABLE `list_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`category` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_statuses_list_idx` ON `list_statuses` (`list_id`,`position`);--> statement-breakpoint
ALTER TABLE `list_items` ADD `status_id` text;
