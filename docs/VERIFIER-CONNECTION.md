# Sendzad verifier connection - 3 November 2026

## What this update connects

Both application editions now route verification to the independent Go engine.
New lists default to Sendzad. Explicitly selected Reoon lists and every existing
unbound job keep Reoon. There is no automatic paid fallback. Saving a list does
not start it. Template, campaign, SMTP account and suppression data are not migrated.

The original TypeScript verification service remains intact for legacy Reoon
work. The application API entrypoint, browser-compatible /api/email-v2 routes and
protected /api/email/worker use the new provider router. Non-email channels still
use the preserved original API implementation in app/lib/legacy-server.ts.
The PHP worker dispatches before opening a Reoon credential, so Sendzad jobs do
not require or consume a Reoon key.

This is source integration, not a live deployment. No production verifier URL,
API token, server control or live-site publishing capability was supplied. A
successful source commit or local test cannot substitute for host acceptance.

## Install the verifier

Use services/email-verifier/README.md and its supplied Linux service/reverse-proxy
configuration. The Go service must be running behind authenticated HTTPS with
outbound SMTP access permitted by its host. Do not put it in public_html or expose
its loopback port. Use your own dedicated HTTPS origin and private bearer token.
Do not put either application's credentials in GitHub, chat or browser scripts.
The same or separate server is supported through the HTTPS service boundary.

## PHP/MySQL edition

1. Back up the application, database and stable application encryption key.
2. Apply shared-hosting/private/database/migrations/0003_self_verifier.sql to the
   existing application database. It is additive and repeatable. Apply it after
   schema.sql for a NEW installation too. Do not re-import schema.sql into a live
   database. The separate 0002_saved_templates migration remains necessary for
   the independent template studio.
3. Set these keys in the existing private/config.php, preserving all other keys:

   self_verifier_url: your dedicated HTTPS origin, with no /v1 path
   self_verifier_token: the matching private Go-service API token

   Alternatively use server environment variables SENDZAD_VERIFIER_URL and
   SENDZAD_VERIFIER_TOKEN. config.example.php demonstrates this arrangement.
   The endpoint is installation-controlled, not accepted from uploaded contacts
   or arbitrary browser input.
4. Run python3 shared-hosting/scripts/build_release.py in the full source checkout.
   Upload PHP changes, public/index.php, verification-connection.js and generated
   assets together. Preserve private config.php, vendor/, database and key.
5. Open Email settings > Verification > Test connection. The service URL/status
   is visible; the bearer token is never returned to the browser. Reoon credentials
   remain a separate secondary setting.
6. Keep the existing CLI verification cron job using private/bin/worker.php verify.
   No campaign-sending cron is launched by verification. Verify the heartbeat.

## Original TypeScript/Cloudflare edition

1. Apply drizzle/0011_sendzad_verifier.sql after migrations 0000-0010. The migration
   journal includes 0011. Use the deployment's existing migration mechanism or
   execute that file once against the intended D1 database. It adds two tables;
   existing records and provider bindings are not rewritten.
2. Configure private runtime values SENDZAD_VERIFIER_URL and
   SENDZAD_VERIFIER_TOKEN. Use a deployment secret for the token. Do not use a
   NEXT_PUBLIC variable or commit a .env with live values.
3. Preserve SMS_SETTINGS_ENCRYPTION_KEY, EMAIL_WORKER_TOKEN_SHA256, APP_ORIGIN and
   the platform's existing authentication controls. Deploy the complete updated
   source, not just the React component.
4. Email verification > Settings > Check service tests the new connection.
   A new list defaults to Sendzad; Reoon requires explicit selection.
5. The existing protected /api/email/worker now processes either provider. Its
   authentication, empty-body requirement and owner/job restrictions remain.
   No new automation or campaign is created by this release.

The new D1 SQL is an additive hand-authored migration. Before future schema
regeneration, represent these two tables in the project's ORM metadata rather
than treating their absence from an older generated snapshot as a deletion.

## Behavior and recovery

A started self-hosted job pins a fingerprint of its URL and token. Changing the
connection pauses that job instead of sending its addresses to a different service.
Restore the original connection or explicitly create a new job. Old Reoon jobs
keep their credential snapshots and reconciliation behavior.

The client sends at most four distinct addresses per step, validates all returned
identities and mailbox evidence, and persists counts and results atomically.
Missing, duplicate or contradictory results pause the job with pending rows intact.
Positive means likely deliverable, not confirmed ownership or guaranteed delivery.
Unknown/risky results and spam-trap not-assessed are not promoted to valid.

Temporary mailbox results have up to three substantive attempts. Provider cooldowns
have a separate ceiling of 30 deferrals. Network/configuration/contract failures
pause for review instead of spending paid credits or silently losing addresses.
Interrupted self-hosted checks may be probed again after a lease expires: these
operations never submit message content. Uncertain paid Reoon submissions retain
the original no-automatic-repurchase behavior.

## Acceptance and local evidence

Executed locally in this change:
- 62 Node checks: real transport/router/entrypoint/protected-worker source;
  actual SQLite statement execution with synthetic legacy/provider fixtures.
- 31 PHP contract and simulated transition checks; no real database or cURL call.
- 15 Chromium browser interaction checks of the shipped PHP connection module
  using an offline synthetic API.
- Strict TypeScript checking of the transport/router; PHP syntax checks.

The native MySQL integration recipe now applies the additive migration and names
Reoon explicitly in legacy-provider test cases. It was NOT run here: pdo_mysql and
DOM are unavailable. Full application builds, authenticated PHP-host integration,
real SMTP/provider callbacks and real-mailbox accuracy tests were NOT run. No live
jobs, credentials, contact data, paid credits or campaign sends were used.

Before production, use services/email-verifier/acceptance.py with controlled
known-valid and known-absent mailboxes. Health reports configuration readiness,
not that port 25 or mailbox accuracy has been proven. Then run one small explicitly
started list through the deployed Sendzad UI, confirm stored results, pause/resume
and add-valid behavior. Do not relabel unknown responses as a successful test.
