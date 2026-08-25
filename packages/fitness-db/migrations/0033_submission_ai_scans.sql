-- submission_ai_scans — automatic AI triage of incoming admin-review
-- submissions (exercise + food), advisory verdict/findings only
-- (see packages/fitness-db/src/schema/submission-ai-scans.ts).
CREATE TABLE `submission_ai_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verdict` text,
	`findings` text,
	`model` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `submission_ai_scans_subject_idx` ON `submission_ai_scans` (`subject_type`,`subject_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `submission_ai_scans_status_idx` ON `submission_ai_scans` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_ai_scans_pending_subject_uq` ON `submission_ai_scans` (`subject_type`,`subject_id`) WHERE "submission_ai_scans"."status" = 'pending';
