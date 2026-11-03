-- Additive provider binding. No existing job is reassigned or restarted.
CREATE TABLE IF NOT EXISTS tz_self_verification_jobs (
 job_id CHAR(32) PRIMARY KEY, config_hash CHAR(64) NULL,
 FOREIGN KEY(job_id) REFERENCES tz_verification_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_self_verification_results (
 item_id BIGINT UNSIGNED PRIMARY KEY, attempts INT NOT NULL DEFAULT 0,
 deferrals INT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL DEFAULT 0,
 reason VARCHAR(100) NOT NULL, evidence MEDIUMTEXT NOT NULL,
 FOREIGN KEY(item_id) REFERENCES tz_verification_items(id), INDEX self_results_due(next_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
