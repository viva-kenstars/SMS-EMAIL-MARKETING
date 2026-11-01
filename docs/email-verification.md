# Email verification operations

## Using the feature

1. Open **Email verifier → Reoon settings** and save your API key. The connection check reads account credits; it does not verify an address.
2. Import a UTF-8 CSV/text file or paste addresses. For CSV, review the detected delimiter, header and email column. The preview is bounded and the original file is read incrementally.
3. Finish the upload and review the unique eligible count. **Start verification** explicitly authorizes sharing these addresses with Reoon and spending the displayed maximum number of verification credits.
4. Track saved progress, review Invalid/Risky/Unknown results, and export the desired category. A completed run includes Unknown outcomes. It never loops until every address can be declared valid or invalid.

Rows containing unsupported quoted or international address formats are identified for review, rather than being marked as verified mailboxes. Domain casing is normalized; local-part casing and plus-address aliases are preserved. The application does not silently rewrite typo domains or merge Gmail dots/plus tags.

The source file's non-email columns are used for column selection only. Results preserve the original email value and source-row reference; this release does not retain arbitrary uploaded business metadata.

## Capacity and data model

The total row count is not artificially capped. Practical capacity is bounded by storage, provider credits, quotas, and elapsed processing time.

- A browser reads the source in 64 KiB pieces.
- An import chunk holds at most 500 rows and is shortened when its encoded payload approaches 768 KiB. The server enforces 1 MiB per request and 1,024 characters per selected email cell. CSV records/columns have independent parser safety limits.
- The server stores a SHA-256 digest for each numbered chunk. Same-content replay is harmless; a changed chunk at an existing index is rejected.
- The import must be sealed with matching total row and chunk counts before verification can start. A closed browser cannot upload bytes that remain only on the user's computer; background processing applies after upload.
- `email_rows` retains original rows. `email_targets` deduplicates eligible identities and tracks how many source rows share each result.
- Per-job counters are maintained in the same database transactions as import/result updates. Progress and export totals do not rescan the entire list on every request.
- Results and history use stable cursors. The interface renders 100 result rows; export pages hold at most 1,000.
- Native bulk tasks contain at most 2,000 addresses. Credit-aware splitting preserves the provider's minimum of 10 and avoids a 1–9-address bulk tail. Logical lists below 10 use Power verification.

Reoon's own bulk endpoint accepts up to 50,000 addresses per task and processes queued tasks sequentially. The application's smaller provider batches bound result parsing and recovery work. They are not a claim of faster provider verification.

## Completion and recovery

Jobs move through uploading, ready, running, waiting for credits, paused, needs attention, completed or cancelled. Only a job that an authenticated owner explicitly started is eligible for background advancement.

Each worker claim has a persisted 180-second lease. A paid submission intent is stored before contacting Reoon. A known task ID is retained even if cancellation or a subsequent database write interrupts acknowledgement handling. A `submitting` record left by a crash becomes uncertain when recovered; it is never treated as permission to create another task.

Balance, task creation and bulk polling use bounded 15-second provider requests. Small-list Power checks allow 90 seconds because the provider may need more than a minute to check an individual mailbox. One background HTTP callback advances at most one job operation, within a 120-second client deadline.

Accepted tasks can retrieve results using the credential snapshot that submitted them. New paid submissions require the current verified credential generation. Saving an identical key preserves verification; changing or removing credentials stops new use of that generation. Explicit authentication rejection clears only the checked verification, without overriding newer successful checks.

Temporary polling failures use backoff. Insufficient credits preserve the remainder and schedule a later balance check. No code buys credits. Unknown provider results are final for that run, with manual review available.

Cancellation first commits a small stop flag. Pending and processing rows receive a cancelled/unknown view without an unbounded cleanup transaction. Existing verified results remain available, and accepted provider work cannot be recalled by this interface.

Manual task reconciliation must match the stored address set. Completed results from an unrelated task, even one with the same address count, are rejected. A task cannot be attached to multiple batches concurrently. Lease guards prevent reconciliation and late provider responses from resurrecting cancelled work.

## Background processing on the private Site

The hosted administrative app retains owner-private Sites authentication. The callback is:

```text
POST /api/email/worker
Content-Type: application/json
OAI-Sites-Authorization: Bearer <current Site service credential>
X-Email-Worker-Token: <the same service credential>

{}
```

Sites validates its service-access header at the hosting boundary. The application separately hashes `X-Email-Worker-Token` and compares it with protected runtime variable `EMAIL_WORKER_TOKEN_SHA256`. Only the fingerprint is stored in the runtime configuration. Never put the service credential in source, a URL, shell arguments, a schedule prompt or browser code.

The callback only advances existing, explicitly started jobs. It accepts an empty JSON object; it cannot select another owner, import a list, save an API key, start a draft, or send a campaign message. Its response contains progress metadata, not address results or credentials. `/api/email/runner` returns a signed-in user's safe heartbeat/status view.

Use native Sites `get_site` to obtain current service access without printing it. `scripts/hash-email-worker-token.mjs` reads `{"serviceToken":"…"}` from hidden stdin and emits its SHA-256 fingerprint. Set that fingerprint as a protected `EMAIL_WORKER_TOKEN_SHA256` runtime value, retaining the existing `SMS_SETTINGS_ENCRYPTION_KEY`. Redeploy after a runtime configuration change.

`scripts/run-email-queue.mjs` reads the following shape from hidden stdin:

```json
{"siteUrl":"https://your-private-site.example/","serviceToken":"obtain through the hosting service"}
```

It issues bounded callbacks, waits only for short due intervals, and prints aggregate progress. It does not log the credential or provider response body. The recurring caller should obtain fresh service access each run and invoke only this published endpoint. If the Site service credential is rotated, update its stored fingerprint before resuming the caller.

When an HTTP/HTTPS proxy is configured, use Node.js 24.5 or newer. The runner enables Node's environment-proxy support before reading its hidden input, preserving the configured network route. It fails clearly on an older runtime instead of making a direct request that silently ignores the proxy.

The linked cloud task checks for already-started verification work hourly. The interface accepts its successful heartbeat for 75 minutes, allowing scheduling jitter. A missing/stale runner is displayed explicitly. While the page remains open and visible, it can advance due work using the owner's normal authenticated API; server leases protect overlap with a scheduled callback. The separate SMTP companion may also advance verifier work through its optional independent loop. Neither verification callback launches a message campaign.

For independent hosting, configure a trusted authentication boundary that supplies the user identity headers, provision D1/migrations and the master encryption key, and arrange a scheduler for the protected callback. Do not expose an installation that trusts visitor-supplied identity headers directly. GitHub source publication by itself does not provision these runtime services.

## Exports

The native save-file path writes successive pages directly to disk. A cancelled file-picker action does not silently trigger a download. On browsers/embeds without that capability, each click downloads one bounded part (at most 50,000 rows or roughly 8 MiB, plus the final page). The continuation cursor allows every remaining row to be exported. This is a per-file memory safeguard, not a job-row limit.

An export made during processing reflects saved results while it runs. Category membership can change as new provider results arrive; use a completed job for a final stable report. Continuation checkpoints reset when the job's saved results change. CSV values are quoted and potentially executable spreadsheet formulas are neutralized.

## Verification and provider documentation

Run `npm test` for all suites, `npm run test:email` for the email-specific suites and `npm run typecheck` for the TypeScript check. Tests use fake credentials and synthetic `example.net` addresses. No real mailbox verification, SMS, WhatsApp message or credit purchase is part of automated testing.

Primary references reviewed 29 October 2026:

- Reoon API, statuses, bulk limits and credits: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/
- Reoon status meaning: https://www.reoon.com/articles/meaning-of-different-email-verification-statuses/
- Reoon credit policy: https://www.reoon.com/email-verifier/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Workers request/background execution: https://developers.cloudflare.com/workers/runtime-apis/context/

This implementation uses a persistent D1 job ledger and authenticated scheduled callbacks. It does not rely on an in-memory queue, browser timers for unattended work, or `waitUntil()` keeping a request alive indefinitely.
