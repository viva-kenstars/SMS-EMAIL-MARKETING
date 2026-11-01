CREATE TABLE `email_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`batch_index` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text,
	`count` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_poll_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `email_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_batches_job_index` ON `email_batches` (`job_id`,`batch_index`);--> statement-breakpoint
CREATE INDEX `email_batches_job_status` ON `email_batches` (`job_id`,`status`);--> statement-breakpoint
CREATE TABLE `email_chunks` (
	`job_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`digest` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `email_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_chunks_job_index` ON `email_chunks` (`job_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `email_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`next_chunk_index` integer DEFAULT 0 NOT NULL,
	`sealed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`credential_revision` integer,
	`credential_ciphertext` text,
	`next_run_at` integer,
	`lease_token` text,
	`lease_until` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_jobs_owner_created` ON `email_jobs` (`owner`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `email_jobs_queue` ON `email_jobs` (`status`,`next_run_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `email_rows` (
	`job_id` text NOT NULL,
	`position` integer NOT NULL,
	`source_row` text,
	`email` text NOT NULL,
	`normalized_email` text,
	`local_status` text,
	`local_reason` text,
	FOREIGN KEY (`job_id`) REFERENCES `email_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_rows_job_position` ON `email_rows` (`job_id`,`position`);--> statement-breakpoint
CREATE INDEX `email_rows_job_address` ON `email_rows` (`job_id`,`normalized_email`);--> statement-breakpoint
CREATE TABLE `email_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`api_key_ciphertext` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`credential_revision` integer DEFAULT 1 NOT NULL,
	`verified_at` integer,
	`daily_credits` integer,
	`instant_credits` integer,
	`balance_checked_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_targets` (
	`job_id` text NOT NULL,
	`email` text NOT NULL,
	`first_position` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`provider_status` text,
	`batch_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `email_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_targets_job_address` ON `email_targets` (`job_id`,`email`);--> statement-breakpoint
CREATE INDEX `email_targets_job_pending` ON `email_targets` (`job_id`,`status`,`first_position`);--> statement-breakpoint
CREATE INDEX `email_targets_batch` ON `email_targets` (`batch_id`);--> statement-breakpoint
CREATE TABLE `email_worker_state` (
	`key` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`last_error` text
);
