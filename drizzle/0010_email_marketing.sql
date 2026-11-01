CREATE TABLE `marketing_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`preheader` text DEFAULT '' NOT NULL,
	`html` text NOT NULL,
	`text_content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`group_ids` text DEFAULT '[]' NOT NULL,
	`account_ids` text DEFAULT '[]' NOT NULL,
	`account_snapshot` text DEFAULT '[]' NOT NULL,
	`relay_revision` integer,
	`postal_address` text DEFAULT '' NOT NULL,
	`interval_seconds` integer DEFAULT 5 NOT NULL,
	`scheduled_at` integer,
	`next_send_at` integer,
	`rotation_index` integer DEFAULT 0 NOT NULL,
	`launch_token` text,
	`lease_token` text,
	`lease_until` integer,
	`started_at` integer,
	`completed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `marketing_campaigns_owner_created` ON `marketing_campaigns` (`owner`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `marketing_campaigns_queue` ON `marketing_campaigns` (`status`,`next_send_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `marketing_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`verified_at` integer NOT NULL,
	`source_job_id` text NOT NULL,
	`suppressed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_contacts_owner_email` ON `marketing_contacts` (`owner`,`email`);--> statement-breakpoint
CREATE TABLE `marketing_group_members` (
	`group_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `contact_id`),
	FOREIGN KEY (`group_id`) REFERENCES `marketing_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `marketing_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `marketing_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `marketing_groups_owner_created` ON `marketing_groups` (`owner`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_groups_owner_name` ON `marketing_groups` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `marketing_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`account_id` text,
	`account_revision` integer,
	`message_id` text,
	`error` text,
	`attempted_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `marketing_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `marketing_contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_recipients_campaign_email` ON `marketing_recipients` (`campaign_id`,`email`);--> statement-breakpoint
CREATE INDEX `marketing_recipients_campaign_status` ON `marketing_recipients` (`campaign_id`,`status`,`id`);--> statement-breakpoint
CREATE TABLE `marketing_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`relay_url` text DEFAULT '' NOT NULL,
	`relay_token_ciphertext` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`credential_revision` integer DEFAULT 1 NOT NULL,
	`relay_verified_at` integer,
	`postal_address` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marketing_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`email` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`message_id` text,
	`error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_tests_owner_request` ON `marketing_tests` (`owner`,`request_id`);--> statement-breakpoint
CREATE TABLE `marketing_worker_state` (
	`key` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `smtp_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`label` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`security` text NOT NULL,
	`username` text NOT NULL,
	`password_ciphertext` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`reply_to` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`credential_revision` integer DEFAULT 1 NOT NULL,
	`daily_limit` integer DEFAULT 500 NOT NULL,
	`min_interval_seconds` integer DEFAULT 5 NOT NULL,
	`sent_today` integer DEFAULT 0 NOT NULL,
	`sent_day` text DEFAULT '' NOT NULL,
	`next_available_at` integer,
	`reservation_token` text,
	`send_lease_until` integer,
	`last_error` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `smtp_accounts_owner_created` ON `smtp_accounts` (`owner`,`created_at`,`id`);