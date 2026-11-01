# Trezad SMS and Email release validation — 1 November 2026

## Scope

This release adds the email marketing workspace, SMTP account management, verified contact groups, HTML campaigns and a persistent sending queue. It also repairs proxy handling in the existing mailbox-verification runner and supplies the separate SMTP service needed for real delivery.

The application release was deployed to its existing owner-private Site. This public source copy omits that Site's address and project identifier. Deployment status and the saved source revision are reported by Sites; a local build alone is not a production deployment.

## Completed checks

| Check | Result |
|---|---|
| Existing application suite before marketing changes | 364 checks passed |
| Final application regression suite | 416 checks passed across all 17 test files |
| New email marketing integration coverage, included above | 51 checks passed |
| Proxy-aware runner CLI regression, included above | 1 check passed |
| TypeScript | `npm run typecheck` passed |
| Production build | Sites build helper / Vinext production build passed |
| Actual built Worker with fresh local D1 | 14 checks passed; zero external requests |
| Separate SMTP service | 28 checks passed, including 7 local SMTP/TLS protocol tests |
| SMTP service syntax | `npm run check` passed |
| Source formatting | `git diff --check` passed |

The built-Worker check loads the generated production JavaScript in workerd, applies all migrations to a fresh isolated D1 database, and blocks outgoing network requests. It verifies authentication, owner isolation, encrypted SMTP password storage, draft persistence and HTML sanitization, group creation, protected worker behavior, runner heartbeat, and serving the setup page and service ZIP. It creates synthetic fixtures only and never launches a campaign.

The regression suite exposed an ESM test-bundling issue after the sanitizer dependency was added. The server harness now loads the actual CommonJS dependency through Node's package loader. The final complete suite passed after that correction. The production sanitizer was independently exercised in the built Worker.

The SMTP service tests use local SMTP servers and generated test certificates. They exercise STARTTLS, implicit TLS, authentication-only verification, MIME submission, certificate and recipient rejection, durable delivery claims, uncertain outcomes, owner isolation, signed unsubscribe links, suppression, and independent background worker callbacks. No real recipient received an email.

An additional 20,001-contact valid-only import fixture exposed an inefficient SQLite join order. The indexed implementation completed that import in approximately 0.69 seconds locally. This synthetic result verifies the large-list path; it is not a production latency or mailbox-deliverability guarantee.

## Existing verification runner

The repaired runner preserves the configured HTTP proxy. A protected request to the existing deployed verification endpoint succeeded with `ok: true`, one request, and zero jobs advanced because none were due.

An enabled hourly task named **Continue Trezad email verification** is attached to the private Site. It advances only verification jobs already started by the owner. It does not launch SMS, WhatsApp or email campaigns. The task's existence and enabled state were verified; a future recurring execution has not yet been observed. The verifier heartbeat allowance is 75 minutes to accommodate the hourly cadence.

The campaign dispatcher has a separate seconds-based queue. Unattended campaign processing requires the deployed SMTP companion's authenticated worker loop. An open, visible email workspace can also advance already launched campaigns.

## Installation and verification still required

- **Live SMTP service hosting:** the service is implemented and packaged, but an external host, HTTPS domain and persistent database have not been provisioned. Install it using the app's Sending setup page and downloadable package.
- **Real SMTP accounts:** no production SMTP credentials were entered or tested. After installation, test the service, test each account, enable the intended accounts, and explicitly send a test campaign to an authorized mailbox.
- **Browser interaction and visual QA:** the managed local preview returned `ERR_CONNECTION_REFUSED`. No browser layout or interaction test was completed. Type checking, production build, API integration tests, template sanitization checks and built-runtime checks passed.
- **Public repository export:** the repository owner explicitly approved public source publication on 1 November 2026. This distribution includes application and SMTP service code, migrations, templates, tests and guides. Credentials, uploaded contacts, runtime databases and private hosting identifiers are excluded. Hosting configuration and the account display label use generic values; deployment access and recurring task registrations remain separate from GitHub branches.

SMTP acceptance is recorded separately from inbox delivery. The release does not claim bounce, open, click or final-delivery tracking without provider evidence. OAuth-only SMTP authentication is not included; supported accounts use username/password or provider-issued app passwords. Missing personalization names fall back to “there”.

## Reviewable source and installation package

- [Email marketing guide](email-marketing.md)
- [SMTP deployment guide](smtp-relay.md)
- [Built-runtime verification script](../scripts/smoke-email-release.mjs)
- [SMTP companion source](../services/smtp-relay/)
- [Private service setup page](../public/smtp-service-setup.html)
- [Service ZIP](../public/downloads/trezad-smtp-service.zip)

The ZIP contains the service source, lockfile, container configuration, example environment placeholders and installation guides. It excludes real secrets, installed dependencies, databases and generated certificate files.
