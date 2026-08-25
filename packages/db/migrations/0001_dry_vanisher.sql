CREATE TABLE `oauth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_identities_user_idx` ON `oauth_identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_identities_provider_subject_idx` ON `oauth_identities` (`tenant_id`,`provider`,`subject`);--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`aaguid` text,
	`backed_up` integer,
	`label` text DEFAULT 'Passkey' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webauthn_credentials_user_idx` ON `webauthn_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`challenge_hash` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'rallypoint' NOT NULL,
	`provider` text NOT NULL,
	`code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`return_to` text NOT NULL,
	`link_user_id` text,
	`browser_bind_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expires_idx` ON `oauth_states` (`expires_at`);