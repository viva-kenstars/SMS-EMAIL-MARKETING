# SMTP relay deployment and operations

## Deployment boundary

The private Trezad Site contains the campaign editor, groups, account management, encrypted SMTP credentials and persistent sending queue. The SMTP relay in `services/smtp-relay/` is a separate Node service because the Sites runtime does not expose raw SMTP TCP connections. The relay also provides recipient-accessible unsubscribe pages, which cannot sit behind the private app's sign-in screen.

This repository supplies the complete service, Dockerfile, Caddy HTTPS proxy, Compose configuration and lockfile. It has not provisioned a server, domain, SMTP account or subscription. To enable real SMTP delivery, deploy it on an approved host with outbound access to your SMTP provider, then enter its HTTPS URL and relay API token in the app's relay settings. An SMTP connection check sends no email. Sending a test campaign requires entering the intended test mailbox and pressing the send-test control.

## Provision the service

1. Use a server with Docker Compose and a persistent disk. Allow inbound TCP 80/443 for the HTTPS proxy and outbound traffic to your SMTP providers' documented TLS ports. Default relay-supported ports are 465, 587 and 2525.
2. Point a dedicated DNS hostname, such as `mail-relay.your-domain.com`, at the server.
3. In `services/smtp-relay/`, copy `.env.example` to `.env`. Keep it outside version control and restrict it to the deployment administrator. For managed platforms, set the same variables through that platform's secret manager.
4. Set `SMTP_RELAY_HOST` to the DNS hostname and `SMTP_RELAY_PUBLIC_URL` to its exact HTTPS origin. Generate two independent cryptographically random values with at least 32 characters for `SMTP_RELAY_TOKEN` and `SMTP_RELAY_SIGNING_KEY`. A local generator is `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Run it twice. Do not paste either value into a public issue, shell command argument, repository or screenshot.
5. Run `docker compose up -d --build`. The Node service stores its SQLite database in the `relay_data` volume. Caddy provisions TLS and forwards HTTPS requests to the private container service.
6. Confirm the public health URL returns the service identifier. The app's relay test uses authenticated `/v1/health`, so an invalid API token cannot appear connected merely because the public health page works.
7. Save the relay origin and API token in the app. Save each SMTP account, test its connection, and enable accounts intended for campaigns. Use an authorized From address and provider-issued app password where required.

If an existing reverse proxy is used, run the Node process on loopback with a persistent `SMTP_RELAY_DATABASE` and forward HTTPS to it. Never expose a plaintext listener publicly; SMTP account credentials are carried in server-to-server HTTPS requests. The service itself does not trust visitor identity headers or grant access based on a claimed owner ID: every private API request needs the relay secret.

## Environment variables

| Variable | Purpose |
|---|---|
| `SMTP_RELAY_PUBLIC_URL` | Exact public HTTPS origin for unsubscribe links |
| `SMTP_RELAY_TOKEN` | API authentication secret; used by the app server |
| `SMTP_RELAY_SIGNING_KEY` | Separate stable secret for unsubscribe signatures and delivery request digests |
| `SMTP_RELAY_DATABASE` | Persistent SQLite path; Compose sets `/app/data/relay.sqlite` |
| `SMTP_ALLOWED_PORTS` | Comma-separated permitted SMTP ports; default `465,587,2525` |
| `SMTP_MAX_CONCURRENT` | Maximum concurrent SMTP operations; default 5, bounded 1–32 |
| `PORT`, `BIND_HOST` | Direct-service listener; defaults to port 3001 on loopback |
| `TREZAD_SITE_URL` | Optional private Site HTTPS origin for unattended queue processing |
| `SITE_PLATFORM_TOKEN` | Optional Sites service-access credential for its sign-in boundary |
| `MARKETING_WORKER_TOKEN` | Optional token matching the app's protected marketing-worker fingerprint |
| `EMAIL_WORKER_TOKEN` | Optional token matching the existing Reoon worker's protected fingerprint |
| `SCHEDULER_INTERVAL_MS` | Marketing-worker polling delay after each callback; minimum/default 1,000 ms |

The optional scheduler requires both the Sites service-access credential and the application worker token. Configure the corresponding runtime fingerprint in the Site before enabling it. Do not substitute forged platform identity headers. If a service credential changes, update the scheduler and its application fingerprint together.

Each marketing tick performs `POST /api/marketing/worker` with an empty JSON object, `OAI-Sites-Authorization: Bearer <SITE_PLATFORM_TOKEN>` and `X-Marketing-Worker-Token: <MARKETING_WORKER_TOKEN>`. An independently scheduled verifier loop can call `POST /api/email/worker` with `X-Email-Worker-Token`. The loops are serial within each queue; a long mailbox verification does not block campaign ticks. Failed callbacks use bounded backoff, never follow redirects, and never log credentials or response bodies. The durable Site queue enforces the campaign's actual intervals, SMTP selections and per-account limits. Polling does not start a draft campaign or expand its recipients.

The scheduler accepts only a bounded JSON response with `ok: true`. A sign-in page, malformed payload or a successful HTTP status containing `ok: false` is a failed callback. The Node 24 container starts with `--use-env-proxy`, preserving configured HTTP/HTTPS proxy routing for these fetch calls. Direct Node deployments behind an HTTP proxy should use a Node version supporting the same flag or `NODE_USE_ENV_PROXY=1`; never disable TLS verification to fix proxy trust.

## Request contracts

All examples below use placeholders, not operational credentials.

`POST /v1/check`:

```json
{
  "account": {
    "host": "smtp.your-provider.com",
    "port": 587,
    "security": "starttls",
    "username": "account-username",
    "password": "server-supplied-secret",
    "fromEmail": "newsletter@your-domain.com",
    "fromName": "Your business",
    "replyTo": "support@your-domain.com"
  }
}
```

The reply is `{ "ok": true }` only after DNS, TCP, TLS and authentication succeed. Nodemailer documents that connection verification does not prove authorization of a particular From address; that is checked by the provider during an actual send.

`POST /v1/send` uses the same `account` plus:

```json
{
  "owner": "server-derived-owner-id",
  "deliveryId": "stable-campaign-recipient-attempt-id",
  "account": { "...": "same shape as above" },
  "message": {
    "to": "recipient@example.net",
    "subject": "Your campaign subject",
    "html": "<h1>Hello</h1><p>Your campaign content.</p>",
    "text": "Hello. Your campaign content.",
    "replyTo": "support@your-domain.com"
  },
  "postalAddress": "Your organisation's postal address"
}
```

The SMTP envelope contains exactly one recipient. The relay appends an unsubscribe footer and the optional postal address to HTML and text content; it also replaces `{{unsubscribe_url}}` if the template uses that variable. Credentials stay in memory for this operation. The relay never persists account passwords or message content.

Completed operation replies use HTTP 200 and one of `accepted`, `failed`, `unknown` or `suppressed`. HTTP 400 rejects malformed/unsupported configuration before an SMTP attempt; HTTP 401 rejects the API credential; HTTP 409 rejects reuse of a delivery ID for a different payload; HTTP 429 means the relay concurrency limit was reached before a new operation began. An unexpected server error must be treated as uncertain by callers. Retry the exact same stable delivery ID to retrieve existing relay status, never invent a fresh ID as an automatic retry after an uncertain send.

Failures also return a persisted machine-readable `code`: `smtp_auth`, `smtp_tls`, `smtp_rate_limit`, `smtp_sender_or_recipient`, `smtp_rejected`, `smtp_config` or `smtp_unknown`. An explicit permanent RCPT rejection has `scope: "recipient"`; other failed SMTP operations have `scope: "account"`. The campaign queue should pause on account failures and unknown outcomes instead of marking every remaining contact failed. A recipient-specific rejection may be recorded for that recipient without stopping unrelated mail. These codes do not authorize an automatic retry or moving an uncertain delivery to another SMTP account.

`GET /v1/suppressions` is authenticated and owner scoped. It accepts `owner`, decimal string `cursor` and `limit` of 1–500. Continue using the returned `nextCursor` until null. The cursor follows stable insertion IDs and does not skip earlier pages when more suppressions arrive. The relay checks its own suppression table before every submission, even if the app's cached suppression list has not yet synchronized.

## Delivery safety and recovery

Before opening SMTP, the service commits an `attempting` record to SQLite with synchronous durable writes. The key is `(owner, deliveryId)` and its request digest covers the immutable SMTP account, recipient and content using an HMAC. Matching repeats return the existing result; changed requests receive HTTP 409. A process crash leaves an intent that becomes `unknown` on startup and cannot cause an automatic second submission. A timeout, connection loss or missing final acceptance also produces `unknown`.

This design provides **at most one SMTP attempt for a stable ID while the ledger is retained**. It deliberately trades automatic replay for protection against duplicate mail. It cannot guarantee exactly-once inbox delivery across an upstream SMTP server. Unknown results require provider-history review. A successful SMTP response means the provider accepted the message; final delivery, bounces and complaints depend on provider reporting. This generic relay does not invent delivery confirmations or an inbound bounce webhook.

Keep the database volume, its WAL state and the signing key. Use a consistent SQLite backup or briefly stop the service for filesystem backups; copying only a live `.sqlite` file can omit WAL changes. Restrict database/backup access: the relay stores suppression email addresses and delivery metadata, although it does not store passwords or email bodies. Do not prune delivery IDs while a campaign can be retried or resumed. Restoring an old or empty ledger weakens duplicate protection for deliveries absent from that backup.

The unsubscribe signing key must remain stable for old links and request digests. Changing it invalidates previously issued links and makes repeated deliveries fail their digest comparison. Rotate only as a planned migration that preserves old verification keys and retained delivery identity, not as a routine restart. The authentication token can be rotated separately after updating the app's encrypted relay settings.

## Transport security

The service requires either implicit TLS or mandatory STARTTLS, validates certificates against the configured SMTP hostname and enforces TLS 1.2 or newer. It never falls back to plaintext or disables certificate checks. Only public DNS hostnames are accepted. All DNS answers must be public unicast addresses; a private or reserved answer causes rejection. The selected public IP is pinned for that connection, while the original hostname supplies SNI and certificate validation, avoiding a second DNS resolution after the safety check.

Nodemailer file and URL loading are disabled, the SMTP envelope is built by the relay, and caller-provided arbitrary headers or attachments are not accepted. API responses contain safe error categories, without raw provider text or credentials. Public unsubscribe routes have no data-listing capability, signed tokens cannot select an unrelated owner/address, and GET requests never change suppression state.

## Unsubscribe and sender authentication

GET on a signed unsubscribe URL presents a confirmation form. POST accepts either the form confirmation or `List-Unsubscribe=One-Click`, using URL-encoded or multipart form bodies. No recipient login or API token is required. Unsubscribe is permanent within that sender/owner's relay suppression list and prevents new submissions through any of their SMTP accounts.

The relay emits `List-Unsubscribe` and `List-Unsubscribe-Post` headers. RFC 8058 also requires a valid DKIM signature covering both headers before mailbox providers offer one-click UI. Configure SPF, DKIM and DMARC with the actual SMTP provider and ensure its DKIM signature covers the unsubscribe headers; adding headers alone does not satisfy the complete requirement. Existing provider quotas, sender verification and acceptance policies continue to apply when accounts rotate.

## Validation

Run `npm ci`, `npm run check`, and `npm test` in `services/smtp-relay/`. The tests use fake accounts and local SMTP/HTTP fixtures. They cover strict STARTTLS and implicit TLS, authentication without sending, actual MIME submission to a local fixture, certificate rejection, missing STARTTLS, recipient rejection, DNS/private-address protection, concurrent and interrupted delivery claims, no replay of uncertain sends, owner isolation, signed unsubscribe confirmation, pagination and authenticated independent worker loops. They are not evidence of real-provider inbox delivery or production relay deployment.

Primary references, reviewed 1 November 2026:

- Nodemailer SMTP, TLS, address pinning and verify semantics: <https://nodemailer.com/smtp>
- Nodemailer error categories: <https://nodemailer.com/errors>
- SMTP test server: <https://nodemailer.com/extras/smtp-server>
- Node SQLite durability APIs: <https://nodejs.org/api/sqlite.html>
- One-click unsubscribe and DKIM: <https://www.rfc-editor.org/rfc/rfc8058.html>
