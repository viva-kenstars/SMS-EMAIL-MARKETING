CREATE TABLE `sender_id_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`credential_revision` integer NOT NULL,
	`sender_id` text NOT NULL,
	`sender_key` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_requests_owner_connection_name` ON `sender_id_requests` (`owner`,`credential_revision`,`sender_key`);--> statement-breakpoint
ALTER TABLE `settings` ADD `sender_approval_source` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `sender_credential_revision` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `sender_verified_at` integer;