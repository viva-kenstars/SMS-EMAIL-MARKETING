CREATE TABLE `provider_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`api_key_ciphertext` text,
	`base_url` text DEFAULT '' NOT NULL,
	`live_enabled` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
