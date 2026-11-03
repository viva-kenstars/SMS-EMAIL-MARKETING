-- Additive; existing jobs intentionally remain unbound and use Reoon.
CREATE TABLE IF NOT EXISTS email_verification_engines (
 job_id TEXT PRIMARY KEY REFERENCES email_jobs(id) ON DELETE CASCADE,
 engine TEXT NOT NULL CHECK(engine IN ('sendzad','reoon')),
 config_hash TEXT, created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_self_results (
 job_id TEXT NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
 email TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 deferrals INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 evidence TEXT NOT NULL, PRIMARY KEY(job_id,email)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_self_results_due ON email_self_results(job_id,next_at);
