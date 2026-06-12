ALTER TABLE `list_items` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `list_items_parent_idx` ON `list_items` (`list_id`,`parent_id`);
