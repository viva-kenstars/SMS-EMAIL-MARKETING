-- Sendzad shared-hosting edition. Import into a NEW MySQL 5.7+/MariaDB 10.5+ database.
-- This is not a migration for the existing Cloudflare D1 database.
SET NAMES utf8mb4;
CREATE TABLE IF NOT EXISTS tz_admins (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE,
 password_hash VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_settings (
 name VARCHAR(64) PRIMARY KEY, value MEDIUMTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_login_attempts (
 bucket CHAR(64) PRIMARY KEY, attempts INT NOT NULL DEFAULT 0, reset_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_groups (
 id CHAR(32) PRIMARY KEY, name VARCHAR(120) NOT NULL, created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_contacts (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL UNIQUE,
 name VARCHAR(120) NOT NULL DEFAULT '', consent TINYINT NOT NULL DEFAULT 0,
 verification VARCHAR(20) NOT NULL DEFAULT 'unverified', verified_at BIGINT NULL,
 suppressed TINYINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
 INDEX contacts_status(verification,suppressed,consent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_members (
 group_id CHAR(32) NOT NULL, contact_id BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY(group_id,contact_id), INDEX members_contact(contact_id),
 FOREIGN KEY(group_id) REFERENCES tz_groups(id), FOREIGN KEY(contact_id) REFERENCES tz_contacts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_accounts (
 id CHAR(32) PRIMARY KEY, label VARCHAR(120) NOT NULL,
 provider VARCHAR(24) NOT NULL DEFAULT 'smtp', config_cipher MEDIUMTEXT NOT NULL,
 generation INT NOT NULL DEFAULT 1, verified_at BIGINT NULL,
 enabled TINYINT NOT NULL DEFAULT 0, daily_limit INT NOT NULL DEFAULT 100,
 min_interval INT NOT NULL DEFAULT 5, usage_day CHAR(10) NOT NULL DEFAULT '',
 used_today INT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL DEFAULT 0,
 last_error VARCHAR(255) NULL, created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_campaigns (
 id CHAR(32) PRIMARY KEY, name VARCHAR(120) NOT NULL, subject VARCHAR(200) NOT NULL,
 preheader VARCHAR(250) NOT NULL DEFAULT '', html MEDIUMTEXT NOT NULL, text_body MEDIUMTEXT NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'draft', revision INT NOT NULL DEFAULT 1,
 track_opens TINYINT NOT NULL DEFAULT 0, track_clicks TINYINT NOT NULL DEFAULT 0,
 interval_seconds INT NOT NULL DEFAULT 5, due_at BIGINT NULL,
 cursor_account INT NOT NULL DEFAULT 0, started_at BIGINT NULL,
 last_error VARCHAR(255) NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
 INDEX campaigns_due(status,due_at), INDEX campaigns_created(created_at,id), INDEX campaigns_updated(updated_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_campaign_accounts (
 campaign_id CHAR(32) NOT NULL, account_id CHAR(32) NOT NULL,
 position INT NOT NULL, generation INT NOT NULL,
 PRIMARY KEY(campaign_id,account_id),
 FOREIGN KEY(campaign_id) REFERENCES tz_campaigns(id), FOREIGN KEY(account_id) REFERENCES tz_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_recipients (
 id CHAR(32) PRIMARY KEY, campaign_id CHAR(32) NOT NULL,
 contact_id BIGINT UNSIGNED NULL, email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
 name VARCHAR(120) NOT NULL DEFAULT '', status VARCHAR(24) NOT NULL DEFAULT 'pending',
 account_id CHAR(32) NULL, message_id VARCHAR(255) NULL, is_test TINYINT NOT NULL DEFAULT 0,
 attempted_at BIGINT NULL, accepted_at BIGINT NULL, delivered_at BIGINT NULL,
 opened_at BIGINT NULL, machine_opened_at BIGINT NULL, clicked_at BIGINT NULL,
 bounced_at BIGINT NULL, unsubscribed_at BIGINT NULL, complained_at BIGINT NULL,
 error VARCHAR(255) NULL, created_at BIGINT NOT NULL,
 UNIQUE KEY audience_once(campaign_id,email,is_test), INDEX recipient_queue(campaign_id,status,is_test), INDEX recipient_accepted(accepted_at),
 FOREIGN KEY(campaign_id) REFERENCES tz_campaigns(id), FOREIGN KEY(contact_id) REFERENCES tz_contacts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_events (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, recipient_id CHAR(32) NOT NULL,
 source VARCHAR(24) NOT NULL, event_key CHAR(64) NOT NULL, kind VARCHAR(24) NOT NULL,
 machine TINYINT NOT NULL DEFAULT 0, occurred_at BIGINT NOT NULL,
 UNIQUE KEY event_once(source,event_key), INDEX event_recipient(recipient_id,occurred_at),
 FOREIGN KEY(recipient_id) REFERENCES tz_recipients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_links (
 id CHAR(32) PRIMARY KEY, recipient_id CHAR(32) NOT NULL, url TEXT NOT NULL,
 FOREIGN KEY(recipient_id) REFERENCES tz_recipients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_verification_jobs (
 id CHAR(32) PRIMARY KEY, name VARCHAR(120) NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'ready', key_cipher TEXT NULL,
 next_at BIGINT NOT NULL DEFAULT 0, last_error VARCHAR(255) NULL,
 started_at BIGINT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
 INDEX verification_due(status,next_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_verification_batches (
 id CHAR(32) PRIMARY KEY, job_id CHAR(32) NOT NULL, status VARCHAR(24) NOT NULL,
 remote_id VARCHAR(128) NULL, created_at BIGINT NOT NULL,
 FOREIGN KEY(job_id) REFERENCES tz_verification_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_verification_items (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, job_id CHAR(32) NOT NULL,
 contact_id BIGINT UNSIGNED NOT NULL, batch_id CHAR(32) NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'pending', checked_at BIGINT NULL,
 UNIQUE KEY verification_once(job_id,contact_id), INDEX verification_queue(job_id,status),
 FOREIGN KEY(job_id) REFERENCES tz_verification_jobs(id), FOREIGN KEY(contact_id) REFERENCES tz_contacts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor VARCHAR(64) NOT NULL,
 action VARCHAR(64) NOT NULL, object_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
