CREATE TABLE `muscle_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `muscles` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `muscle_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `muscles_group_idx` ON `muscles` (`group_id`);--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text,
	`discipline` text NOT NULL,
	`movement_pattern` text NOT NULL,
	`metric_shape` text NOT NULL,
	`unilateral` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercises_global_name_uq` ON `exercises` (lower("name")) WHERE "exercises"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `exercises_custom_name_uq` ON `exercises` (`owner_user_id`,lower("name")) WHERE "exercises"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX `exercises_owner_idx` ON `exercises` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `exercises_discipline_idx` ON `exercises` (`discipline`);--> statement-breakpoint
CREATE TABLE `exercise_muscles` (
	`exercise_id` text NOT NULL,
	`muscle_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`exercise_id`, `muscle_id`),
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`muscle_id`) REFERENCES `muscles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exercise_muscles_muscle_idx` ON `exercise_muscles` (`muscle_id`);