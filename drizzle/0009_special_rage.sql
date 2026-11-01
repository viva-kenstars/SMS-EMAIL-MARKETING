ALTER TABLE `email_jobs` ADD `pending_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `processing_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `valid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `invalid_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `risky_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `unknown_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `duplicate_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `eligible_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `invalid_syntax_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_jobs` ADD `pending_targets` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_targets` ADD `occurrence_count` integer DEFAULT 1 NOT NULL;