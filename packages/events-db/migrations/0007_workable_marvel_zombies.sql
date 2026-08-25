-- AI lineup ingestion proposals (system-owned festivals). Purely
-- additive: one new table + indexes. NOTE: drizzle-kit also wanted to
-- re-add events.ref here because 0006_personal_event_ref.sql was
-- hand-written without a meta snapshot; those duplicate statements were
-- removed (0006 already applied them) and the 0007 snapshot now carries
-- the ref column, healing the snapshot drift.

CREATE TABLE `lineup_ingestions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text,
	`source_excerpt` text NOT NULL,
	`model` text NOT NULL,
	`extracted` text NOT NULL,
	`proposal` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`ai_response_id` text,
	`created_by` text NOT NULL,
	`reviewed_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lineup_ingestions_event_idx` ON `lineup_ingestions` (`event_id`);--> statement-breakpoint
CREATE INDEX `lineup_ingestions_status_idx` ON `lineup_ingestions` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `lineup_ingestions_pending_event_uq` ON `lineup_ingestions` (`event_id`) WHERE "lineup_ingestions"."status" = 'pending';
