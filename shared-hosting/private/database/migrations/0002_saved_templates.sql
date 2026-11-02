-- Additive migration. Never re-import schema.sql over an existing installation.
CREATE TABLE IF NOT EXISTS tz_templates (
 id CHAR(32) PRIMARY KEY,
 name VARCHAR(120) NOT NULL,
 category VARCHAR(60) NOT NULL DEFAULT '',
 subject VARCHAR(200) NOT NULL DEFAULT '',
 preheader VARCHAR(250) NOT NULL DEFAULT '',
 html MEDIUMTEXT NOT NULL,
 text_body MEDIUMTEXT NOT NULL,
 revision INT UNSIGNED NOT NULL DEFAULT 1,
 archived TINYINT NOT NULL DEFAULT 0,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 INDEX template_list (archived,updated_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tz_template_versions (
 template_id CHAR(32) NOT NULL,
 revision INT UNSIGNED NOT NULL,
 snapshot MEDIUMTEXT NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY (template_id,revision),
 CONSTRAINT template_version_parent FOREIGN KEY (template_id) REFERENCES tz_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
