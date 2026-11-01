CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`batch_index` integer NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `batches_campaign` ON `batches` (`campaign_id`,`batch_index`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`message` text NOT NULL,
	`sender_id` text NOT NULL,
	`channel` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`recipient_count` integer NOT NULL,
	`segments` integer NOT NULL,
	`encoding` text NOT NULL,
	`estimated_cost` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_owner_date` ON `campaigns` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`group_name` text DEFAULT 'General' NOT NULL,
	`consent` integer DEFAULT 0 NOT NULL,
	`suppressed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_owner_phone` ON `contacts` (`owner`,`phone`);--> statement-breakpoint
CREATE TABLE `recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`reason` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipients_campaign_status` ON `recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `recipients_campaign_phone` ON `recipients` (`campaign_id`,`phone`);--> statement-breakpoint
CREATE TABLE `settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`sender_id` text DEFAULT 'Trezad' NOT NULL,
	`sender_approved` integer DEFAULT 0 NOT NULL,
	`rate_per_segment` real,
	`transactional_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
