-- exercise_ai_reviews — AI-proposed muscle maps awaiting admin Apply/Dismiss
-- (admin-triggered pipeline; see packages/fitness-db/src/schema/exercise-ai-reviews.ts).
CREATE TABLE `exercise_ai_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`proposed_muscles` text NOT NULL,
	`rationale` text,
	`model` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer
);
--> statement-breakpoint
CREATE INDEX `exercise_ai_reviews_exercise_idx` ON `exercise_ai_reviews` (`exercise_id`);
--> statement-breakpoint
CREATE INDEX `exercise_ai_reviews_status_idx` ON `exercise_ai_reviews` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_ai_reviews_pending_exercise_uq` ON `exercise_ai_reviews` (`exercise_id`) WHERE "exercise_ai_reviews"."status" = 'pending';
