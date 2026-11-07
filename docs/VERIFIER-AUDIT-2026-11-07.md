# Sendzad verifier audit and fixes - 7 November 2026

Baseline: engineering at 39d11be9c5eb0dfc0456fd73dd3ac0ba2ecaded6.
Scope: independent Go verifier, TypeScript result transport, PHP connection/configuration,
verification cron progress, and the dedicated PHP verification-settings screen.
This is a source update, not a live-site deployment or a claim of universal mailbox accuracy.

## Findings and implemented corrections

| Finding | Correction |
|---|---|
| Go emitted syntax=invalid_syntax while both adapters required syntax=invalid. | Engine 1.0.1 uses the canonical field. Both adapters also accept the unambiguous 1.0.0 spelling for a negative syntax result, normalizing it to invalid. A Go-produced fixture is consumed by both languages. |
| A positive SMTP primary code with a contradictory negative enhanced code could be treated as accepted. Embedded status numbers in explanatory text could also be interpreted as recipient evidence. | Enhanced codes are parsed only at the beginning of reply text. Conflicting positive/permanent status codes and inconsistent multiline codes are inconclusive. Primary 4xx stays temporary and retryable, never invalid. |
| Some quoted local parts containing a space or @ were called invalid even though that syntax is outside this engine's supported subset. | These forms, Unicode/EAI and address literals are unknown/unsupported, not proof of nonexistent mailboxes. Full EAI/quoted-mailbox probing is not implemented. |
| Negative labels for null MX/no mail route were insufficiently correlated with the supporting fields. | PHP and TypeScript validate negative routing/syntax evidence and field types as well as positive evidence. Contradictory payloads are rejected as a batch; no made-up results are accepted. |
| An empty PHP config value suppressed the configured environment variable. | Nonempty private config wins; empty/missing values fall back to the documented environment variables. Diagnostic responses never contain the token or its fingerprint. |
| Same-server installations had no explicit local transport mode. | PHP supports an administrator-selected local mode using only http://127.0.0.1:8095. A blank address resolves to this endpoint only in local mode. Remote remains the default and requires a dedicated HTTPS origin. Tokens remain mandatory. |
| PHP used the generic provider transport's broad response size and vague errors. | A verifier-specific transport rejects redirects/non-JSON responses, caps bodies at 32 KiB, uses a 25-second request timeout and distinguishes authentication, timeout and TLS failures without echoing remote responses or credentials. |
| Verification cron stopped after a single step regardless of time remaining. | Self-hosted jobs can advance through a bounded drain, normally up to 10 steps within the 40-second work budget, reserving 25 seconds before additional HTTP calls. Per-mail-server limits remain. Paid-provider jobs retain single-step processing. This is not a promised throughput or hard OS deadline. |
| Cron attention could exit successfully; setup failure was hard to diagnose. | Verification attention now exits nonzero. A read-only doctor checks configuration, required extensions and the existing migration, and optionally reads authenticated health. The settings view shows actionable setup information without claiming a health response proves mailbox acceptance. |
| Existing CI did not comprehensively target the verifier files. | A separate read-only regression workflow covers Go, the TypeScript transport and PHP setup/contracts. It does not deploy, send campaigns, buy credits, or change live data. Its hosted run must be checked separately. |

## Same-server PHP installation

Use local mode only on a machine/network namespace you administer, with the Go
service already running as its restricted service account. Do not use it to trust
another tenant on generic shared hosting. In separate containers, 127.0.0.1 points
to the current container, not another container.

Add to the existing private config.php; preserve every other configuration value:

```php
'self_verifier_mode' => 'local',
'self_verifier_url' => '', // explicit local mode chooses http://127.0.0.1:8095
'self_verifier_token' => getenv('SENDZAD_VERIFIER_TOKEN') ?: '',
'verification_max_steps' => 10,
```

The token must match the Go service token. No address is guessed in remote mode.
A blank token never means unauthenticated access. The Go service is not installed
or started by these settings. Its outbound SMTP permission and HELO/sender setup
remain necessary.

For separate-server PHP deployment, use remote mode and a real HTTPS origin:

```php
'self_verifier_mode' => 'remote',
'self_verifier_url' => getenv('SENDZAD_VERIFIER_URL') ?: '',
'self_verifier_token' => getenv('SENDZAD_VERIFIER_TOKEN') ?: '',
```

The Cloudflare/TypeScript edition continues to require remote HTTPS. Loopback there
is not your application VPS. Do not use NEXT_PUBLIC variables for the token.

HTTP proxy configuration is preserved. If a proxy is configured for local HTTP,
local mode requires an explicitly approved NO_PROXY entry for 127.0.0.1. It does
not silently disable or bypass a required proxy. The Go engine's existing refusal
of unsupported SMTP-proxy configuration remains unchanged.

## Installation and recovery

1. Back up the current installation, database and stable application key.
2. Deploy the changed source together, including VerifierSetup.php and
   VerifierWorker.php. This update creates no new tables. The existing
   0003_self_verifier.sql migration must already be installed for PHP; 0011 is
   still required in the original D1 edition. Never re-import the fresh schema
   over existing records.
3. In the full checkout run `python3 shared-hosting/scripts/build_release.py` and
   deploy the generated assets/manifest so cache-versioned JS is updated too.
4. Build the Go service with a currently maintained toolchain and deploy 1.0.1.
   The adapter remains compatible with 1.0.0's old negative syntax spelling, but
   the SMTP/unsupported-format fixes require updating the engine itself.
5. Run `php shared-hosting/private/bin/verifier-doctor.php` for setup/schema checks.
   Add `--connect` to read authenticated health. The command is CLI-only, performs
   SELECT-only database probes and never verifies contacts or sends mail.
6. Keep the existing `worker.php verify` cron command. It now reports attention
   through a nonzero exit status. The `send` path is unchanged.
7. Use the existing controlled mailbox acceptance procedure on the actual host
   before a small explicitly started contact-list check.

Existing started jobs retain their URL/token fingerprint. Switching to local mode
or rotating the token does not silently rebind an existing job. Restore the pinned
connection or deliberately create a new job from appropriate pending contacts.
Previously saved results are not retroactively rewritten. Opt-outs, consent,
campaigns, SMTP accounts and Reoon credentials are untouched.

## Executed validation

- 46 new Go audit leaf cases passed with the race detector, using in-process SMTP
  protocol fixtures, deterministic DNS and an actual local HTTP test server.
- Go vet passed; the complete engine/API executable compiled locally.
- Actual Go-produced valid, invalid-syntax and null-MX JSON was accepted by both
  TypeScript and PHP adapters.
- 28 Node transport/contract checks passed; strict TypeScript compilation passed.
- 57 isolated PHP configuration, result, HTTP-reply and drain-scheduling checks passed.
- 11 offline Chromium interaction checks passed for the shipped settings module.
- Changed PHP files and JavaScript passed syntax checks.
- Before the correction, new tests reproduced the syntax contract, unsupported
  quoted-address and SMTP contradiction failures.

That is 142 cases across the listed suites, not 142 independent production tests.
Go coverage for the recovered engine and API source plus this audit suite was 68.0%.
Historical Go test files were not replayed locally; the added CI command runs the
whole Go package in the complete repository. Do not add earlier test totals to these.

## Explicitly not verified

No live deployment, target-host credentials, real mailbox probes, paid Reoon calls,
message DATA, campaign sends or contact changes occurred. The container lacks PHP
cURL, PDO MySQL and DOM, so native PHP HTTP/MySQL and full-host integration were not
executed. The PHP HTTP reply/policy and scheduling checks use isolated inputs, not
an actual cURL connection. The full application production build was not run. These
limitations must be cleared on staging; a passing health check is not mailbox accuracy.

The engine still cannot prove ownership, inbox placement, reading or absence of spam
traps. Disposable-domain coverage still needs a reviewed domain list. Full EAI support,
SMTP proxy transport, automatic token rebind and an automatic paid fallback are not
added. Unknown and risky results remain separate. No accuracy or speed percentage is
claimed.

## Research basis

Primary standards and guidance reviewed on 7 November 2026:

- RFC 2034, sections 3-4: enhanced codes prefix the response text, agree with the
  primary code, and agree across multiline replies.
  https://www.rfc-editor.org/rfc/rfc2034.html
- RFC 5321: SMTP reply classes, supported mailbox syntax and verification limitations.
  https://www.rfc-editor.org/rfc/rfc5321.html
- RFC 7505: null MX explicitly declares no mail service; an absent MX record can
  instead use A/AAAA fallback. The existing engine distinction is retained/tested.
  https://www.rfc-editor.org/rfc/rfc7505.html
- OWASP SSRF Prevention Cheat Sheet: restrict destinations, redirects and resolution.
  Local mode uses one fixed loopback endpoint, not arbitrary internal-network access.
  Recipient-derived SMTP destinations retain the existing IP screening and pinning.
  Remote service URLs remain administrator-controlled, not accepted from contacts.
  https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

Reproduce in a complete source checkout with Go, Node, TypeScript and PHP installed:

```sh
sh scripts/test-verifier-audit.sh
# Optional offline UI test requires Python Playwright and Chromium:
python3 tests/verifier-setup-browser.py
```
