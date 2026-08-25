CREATE TABLE `ai_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`parent_id` text,
	`user_id` text NOT NULL,
	`app` text NOT NULL,
	`feature` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`request_json` text,
	`response_json` text,
	`latency_ms` integer NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`finish_reason` text,
	`error` text,
	`cached` integer DEFAULT 0 NOT NULL,
	`content_omitted` integer DEFAULT 0 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_traces_user_idx` ON `ai_traces` (`user_id`);--> statement-breakpoint
CREATE INDEX `ai_traces_trace_idx` ON `ai_traces` (`trace_id`);--> statement-breakpoint
CREATE INDEX `ai_traces_created_idx` ON `ai_traces` (`created_at`);--> statement-breakpoint
CREATE TABLE `ai_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`response_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`final_value_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`response_id`) REFERENCES `ai_traces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_feedback_user_idx` ON `ai_feedback` (`user_id`);--> statement-breakpoint
CREATE INDEX `ai_feedback_response_idx` ON `ai_feedback` (`response_id`);