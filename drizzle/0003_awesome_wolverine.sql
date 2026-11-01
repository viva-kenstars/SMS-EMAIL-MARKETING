CREATE TABLE `whatsapp_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`device_id` text DEFAULT '' NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`template_id` text DEFAULT '' NOT NULL,
	`template_body` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'marketing' NOT NULL,
	`account_approved` integer DEFAULT 0 NOT NULL,
	`template_approved` integer DEFAULT 0 NOT NULL,
	`live_enabled` integer DEFAULT 0 NOT NULL,
	`rate_per_message` real,
	`revision` integer DEFAULT 1 NOT NULL,
	`provider_revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `whatsapp_payload` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `whatsapp_consent_at` integer;