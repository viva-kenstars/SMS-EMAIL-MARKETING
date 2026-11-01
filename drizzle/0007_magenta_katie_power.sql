CREATE TABLE `sms_provider_accounts` (
	`owner` text NOT NULL,
	`provider` text NOT NULL,
	`credentials_ciphertext` text,
	`public_values` text DEFAULT '{}' NOT NULL,
	`configured_fields` text DEFAULT '{}' NOT NULL,
	`verified_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`credential_revision` integer DEFAULT 1 NOT NULL,
	`sender_id` text DEFAULT '' NOT NULL,
	`sender_approved` integer DEFAULT 0 NOT NULL,
	`rate_per_segment` real,
	`transactional_enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sms_accounts_owner_provider` ON `sms_provider_accounts` (`owner`,`provider`);--> statement-breakpoint
CREATE TABLE `sms_routing` (
	`owner` text PRIMARY KEY NOT NULL,
	`active_provider` text,
	`active_credential_revision` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `sms_provider_id` text DEFAULT 'termii' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `sms_credential_revision` integer;
