ALTER TABLE `progress_photos` ADD `set_id` text;--> statement-breakpoint
CREATE INDEX `progress_photos_user_set_idx` ON `progress_photos` (`user_id`,`set_id`);