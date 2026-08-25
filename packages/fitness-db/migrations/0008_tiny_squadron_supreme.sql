CREATE TABLE `training_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`length_weeks` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_plans_owner_name_uq` ON `training_plans` (`owner_user_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `training_plans_owner_idx` ON `training_plans` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `training_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`day_key` text NOT NULL,
	`position` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `training_plan_items_plan_day_pos_idx` ON `training_plan_items` (`plan_id`,`day_key`,`position`);