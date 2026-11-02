# Sendzad independent verifier 1.0.0

A self-hosted Go service with no external verification-credit API and no third-party Go dependencies. It checks syntax, DNS, receiving-server SMTP responses and catch-all behavior. It never issues DATA, AUTH, VRFY or EXPN and cannot send campaigns.

Positive means **likely deliverable**, not ownership, inbox placement, reading, or absence of spam traps. Temporary/policy failures remain unknown. Unknown results are not silently relabeled invalid or sent to a paid provider.

## Build and test

Use a maintained Go toolchain compatible with go.mod:

```sh
cd services/email-verifier
go test -race -cover ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -o sendzad-verifier .
```

Tests use local TCP SMTP, STARTTLS and UDP DNS fixtures, not third-party mailboxes. See the integration and validation notes under repository docs/ for scope and limits.

## Server requirements

Deploy on a suitable Linux server with explicit host permission for outbound TCP 25, a stable public IP, a hostname you control, appropriate forward/reverse DNS, and a real sender address on your domain. Access to SMTP submission on 465/587 does not establish receiving-server port-25 connectivity. Shared-hosting PHP and the existing Cloudflare app call this service through authenticated HTTPS; they do not run the Go process themselves. No host is provisioned by this source commit.

Create an unprivileged sendzad-verifier service account. Install the binary at /usr/local/bin/sendzad-verifier. Create /etc/sendzad-verifier, restricted to that account/root, and generate a random private token locally (for example, using openssl rand -hex 32). Store it in /etc/sendzad-verifier/api-token with mode 0600 and owner sendzad-verifier. Never commit credentials or paste them into chat.

Copy deploy/environment.example to /etc/sendzad-verifier/environment, set the real HELO and envelope sender, and install deploy/sendzad-verifier.service. Bind only to loopback. Put an HTTPS reverse proxy in front; a Caddy example is supplied. Restrict public ingress and keep Authorization headers and recipient payloads out of logs. Enable the unit only after checking these settings and host policy.

STARTTLS with system trust and hostname verification is required by default. An explicit VERIFY_REQUIRE_TLS=false permits plaintext when STARTTLS is unavailable; it never disables certificate verification. Plaintext exposes the checked address on the network and is an operator privacy decision, not the recommended default.

## Network and API safety

All resolved SMTP addresses are screened for private, reserved and metadata ranges, then pinned before dialing. Mixed safe/unsafe DNS answers fail closed. Contact data cannot supply an SMTP host, port, sender, proxy or TLS override. Four checks run at most concurrently, with one per MX hostname, a two-second cooldown and longer backoff on temporary/policy failures. Checks have a 15-second budget. Requests are limited in size and rate; replies never expose raw SMTP responses or private credentials.

This release does not support SMTP SOCKS/HTTP proxy routing. It refuses startup when VERIFY_SMTP_PROXY, ALL_PROXY or all_proxy is configured instead of bypassing it. Do not unset an organization-required proxy to make it work. Use an approved direct-egress deployment or implement and test the required proxy transport. Application and acceptance-runner HTTP(S)_PROXY / NO_PROXY settings are left intact.

Both endpoints require Authorization: Bearer <private-token>:

* GET /v1/health: configuration/contract readiness, not a mailbox test.
* POST /v1/verify: JSON {"emails":["owned-address@your-domain.com"]}, one to four addresses, maximum 4096-byte request. Browser Origin requests are rejected.

Health deliberately returns acceptance_tested:false; use the separate controlled acceptance procedure for live-host evidence. There is no automatic paid fallback.

## Classification and data

A positive result requires target acceptance and a recipient-specific rejection of a random comparison address in a separate envelope. Backup-MX acceptance after a preferred-server failure remains unknown. Sender/policy rejection, 4xx, bare 550, 251/252, TLS failures and inconclusive catch-all replies are not mailbox-invalid proof. Null MX and clear recipient-specific permanent failures are negative evidence.

Quoted local parts, Unicode/EAI and address literals are unsupported, not claimed verified. Local-part case, plus tags and dots are preserved. Role addresses are risky, not necessarily nonexistent. spam_trap is always not_assessed.

Disposable detection is not_assessed unless you supply a reviewed, appropriately licensed domain-per-line file through VERIFY_DISPOSABLE_FILE. No proprietary or comprehensive domain list is bundled. A non-match is not_listed, not guaranteed safe. No signup, password-recovery, breach or private-account lookup is performed.

Domain cache is bounded to 60 seconds because Go's resolver does not expose TTLs. Address cache: valid 30 minutes, invalid 10 minutes, risky five minutes, nonretryable unknown one minute. Retryable results are not cached. All caches are bounded and memory-only. Durable jobs/results remain in the calling application's database. Restarting the service loses caches, not saved application progress. The service is single-tenant; use separate instances/tokens where tenant cache isolation is needed.

## Controlled acceptance before production

Use only mailboxes/domains you own or are explicitly authorized to test. Create a private mode-0600 cases file with known good and nonexistent addresses on a domain whose recipient behavior you control, and optionally a known catch-all case:

```json
[
  {"email":"owned-test@your-domain.com","expected":"valid"},
  {"email":"known-absent@your-domain.com","expected":"invalid"}
]
```

```sh
python3 acceptance.py --url https://verify.your-domain.com \
  --token-file /etc/sendzad-verifier/api-token --cases /private/cases.json \
  --authorized --report /private/acceptance-report.json
```

The runner preserves urllib proxy settings, rejects redirects, uses bounded retries and writes a private report without addresses or tokens. Unknown is a failed expected-valid case, not a manufactured success. No message DATA is submitted. Passing this controlled test does not establish universal provider accuracy or a throughput SLA. Measure false positives, false negatives and unknown rates on a permitted pilot.

## References

Original implementation informed by SMTP/null-MX semantics and public verification patterns; no upstream source was copied:

* https://www.rfc-editor.org/rfc/rfc5321
* https://www.rfc-editor.org/rfc/rfc7505
* https://github.com/AfterShip/email-verifier
