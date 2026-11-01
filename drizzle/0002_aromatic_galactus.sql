ALTER TABLE `campaigns` ADD `audience_source` text DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `direct_consent_at` integer;