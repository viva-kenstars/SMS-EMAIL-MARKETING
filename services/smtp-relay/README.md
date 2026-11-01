# Trezad SMTP relay

This is the SMTP transport and background-worker companion for the private Trezad SMS and Email Marketing app. The hosted Sites app calls this service over HTTPS. This service opens the SMTP TCP connections, keeps a durable delivery-intent ledger, and hosts public unsubscribe links. It does not provide an unauthenticated mail-sending API.

The Sites runtime supports HTTP external connections, so this companion must run on a separate server or container host with outbound SMTP access. Source publication and the private Site deployment do not deploy this service automatically. See [deployment and operations](../../docs/smtp-relay.md) for setup and the complete contract.

## Local checks

Use Node 22.13 or newer; Node 24 is the container runtime. `node:sqlite` is supplied by Node. OpenSSL is needed only to generate an ephemeral certificate for local integration tests.

```sh
npm ci
npm run check
npm test
```

Tests use synthetic `example.net` recipients and local fixtures. They do not send real messages or contact a paid verification provider. Production rejects private SMTP hosts; tests inject a localhost DNS result and a temporary trusted CA directly into the relay constructor. There is no production environment flag or request field that disables that protection.

## Run with HTTPS

```sh
cp .env.example .env
# Fill the values in .env using your deployment's secret manager/editor.
docker compose up -d --build
```

Set DNS for `SMTP_RELAY_HOST` to your server first. Caddy obtains HTTPS certificates. Keep the `relay_data` volume and `SMTP_RELAY_SIGNING_KEY` stable across releases. Losing them removes idempotency history or invalidates existing unsubscribe links. The relay service has no public container port; only the HTTPS proxy is exposed.

`npm start` runs the relay directly on loopback for an existing TLS reverse proxy. It still requires an HTTPS `SMTP_RELAY_PUBLIC_URL`. Configure a persistent `SMTP_RELAY_DATABASE` outside an ephemeral release directory.

## Important behavior

- `POST /v1/check` authenticates to SMTP without sending. It does not prove the provider will authorize the selected From address or deliver to an inbox.
- `POST /v1/send` submits exactly one recipient. An `accepted` result means the upstream SMTP server accepted the submission. It does not mean inbox delivery, reading, or a successful campaign conversion.
- Each `(owner, deliveryId)` is attempted at most once. A retry with the same content returns the stored outcome. Changed content or credentials under the same ID produce HTTP 409. An interrupted or timed-out operation becomes `unknown` and is not automatically replayed.
- Suppression is checked before every new submission and immediately before the SMTP operation. Cancellation cannot recall mail already handed to an SMTP server.
- Authentication, DNS, TLS and explicit recipient rejections produce safe errors. Raw SMTP server text, usernames, passwords and message bodies are not logged or persisted in the relay ledger.
- Every message receives a signed HTTPS unsubscribe link, a text/HTML footer, and List-Unsubscribe headers. GET displays confirmation; POST records suppression. The sending provider must DKIM-sign the unsubscribe headers for mailbox providers to display RFC 8058 one-click controls.
- SMTP rotation and campaign intervals are owned by the app's durable queue. The optional relay scheduler invokes that queue without selecting recipients or starting drafts.

## API endpoints

| Method and route | Authentication | Result |
|---|---|---|
| `GET /health` | Public | `{ "ok": true, "service": "trezad-smtp-relay" }` |
| `GET /v1/health` | Bearer token | Same result; verifies the configured API token |
| `POST /v1/check` | Bearer token | `{ "ok": true }`, or a safe 4xx error |
| `POST /v1/send` | Bearer token | `{ "status": "accepted\|failed\|unknown\|suppressed", "messageId"?: "…", "error"?: "…", "code"?: "…", "scope"?: "account\|recipient" }` |
| `GET /v1/suppressions?owner=…&cursor=0&limit=100` | Bearer token | `{ "items": [{ "email": "…", "createdAt": "…" }], "nextCursor": "…" \| null }` |
| `GET /unsubscribe/:signedToken` | Signed URL | Confirmation form, no mutation |
| `POST /unsubscribe/:signedToken` | Signed URL | Confirmation or RFC 8058 one-click suppression |

All `/v1/` requests use `Authorization: Bearer <SMTP_RELAY_TOKEN>`. JSON mutations require `Content-Type: application/json`. Browser-origin requests are rejected; tokens must remain server-side. The API is rate bounded by `SMTP_MAX_CONCURRENT` and a 1.5 MB request-body limit. Default permitted SMTP ports are 465, 587 and 2525. An operator can add a provider's documented port through `SMTP_ALLOWED_PORTS`; plaintext transport is always prohibited.

## Sources

- Nodemailer SMTP configuration, verify semantics and TLS: <https://nodemailer.com/smtp>
- Nodemailer errors: <https://nodemailer.com/errors>
- Local SMTP fixture: <https://nodemailer.com/extras/smtp-server>
- Node SQLite: <https://nodejs.org/api/sqlite.html>
- One-click unsubscribe and DKIM requirements: <https://www.rfc-editor.org/rfc/rfc8058.html>
