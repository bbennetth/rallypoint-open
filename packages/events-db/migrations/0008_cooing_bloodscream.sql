-- Rebuild event_artists to make day_id NULLABLE (unscheduled/TBA lineup
-- slots — festivals announce artists before day splits). SQLite cannot
-- alter a composite PK, so this is the repo's first table rebuild:
-- create new shape, copy every row verbatim, swap. Identity moves from
-- the PK to two unique indexes (see schema/event-artists.ts for why the
-- full triple index must survive: event_set_stars' composite FK
-- resolves against it). Not data loss: the INSERT..SELECT copies all
-- rows; the swap statements below only exchange table shapes.
--
-- D1 rejects `PRAGMA foreign_keys=OFF`; `PRAGMA defer_foreign_keys=true`
-- is the D1-supported equivalent (auto-resets at transaction end) and
-- covers the window where event_set_stars' FK parent briefly vanishes.
--
-- CRITICAL: dropping the old event_artists performs an implicit DELETE
-- FROM first, which FIRES event_set_stars' ON DELETE CASCADE — deferral
-- does not suppress cascade actions, only constraint checks. Stars are
-- therefore stashed before the swap and restored after (verified by
-- migration-0008.d1.test.ts).

PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_event_artists` (
	`event_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`day_id` text,
	`stage_id` text,
	`tier` text,
	`genre` text,
	`start_time` text,
	`end_time` text,
	`display_name` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`day_id`) REFERENCES `event_days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `event_stages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_event_artists`("event_id", "artist_id", "day_id", "stage_id", "tier", "genre", "start_time", "end_time", "display_name") SELECT "event_id", "artist_id", "day_id", "stage_id", "tier", "genre", "start_time", "end_time", "display_name" FROM `event_artists`;--> statement-breakpoint
CREATE TABLE `__stars_stash` AS SELECT * FROM `event_set_stars`;--> statement-breakpoint
DROP TABLE `event_artists`; -- migration-lint: allow-destructive (rebuild swap, rows copied above; implicit DELETE cascades event_set_stars, restored from __stars_stash below)--> statement-breakpoint
ALTER TABLE `__new_event_artists` RENAME TO `event_artists`; -- migration-lint: allow-destructive (rebuild swap)--> statement-breakpoint
CREATE UNIQUE INDEX `event_artists_slot_uq` ON `event_artists` (`event_id`,`artist_id`,`day_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_artists_unscheduled_uq` ON `event_artists` (`event_id`,`artist_id`) WHERE "event_artists"."day_id" IS NULL;--> statement-breakpoint
INSERT INTO `event_set_stars` SELECT * FROM `__stars_stash`; -- indexes above must exist first: the composite FK resolves against event_artists_slot_uq--> statement-breakpoint
DROP TABLE `__stars_stash`; -- migration-lint: allow-destructive (temp stash, rows restored above)