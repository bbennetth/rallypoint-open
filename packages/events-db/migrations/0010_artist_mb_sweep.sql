CREATE TABLE `artist_mb_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text NOT NULL,
	`mbid` text NOT NULL,
	`match_kind` text NOT NULL,
	`proposed_fields` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE INDEX `artist_mb_reviews_artist_idx` ON `artist_mb_reviews` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_mb_reviews_status_idx` ON `artist_mb_reviews` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `artist_mb_reviews_pending_artist_uq` ON `artist_mb_reviews` (`artist_id`) WHERE "artist_mb_reviews"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `artists` ADD `mbid` text;