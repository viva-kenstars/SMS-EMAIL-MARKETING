# One-server Sendzad deployment

Separate services do not require separate servers. The PHP dashboard, PHP SMTP
workers, MySQL/MariaDB, phpMyAdmin (restricted admin access), and the Go verifier
can share ONE suitable Linux VPS or dedicated server.

```
HTTPS :443 -> Caddy/Nginx -> PHP-FPM -> Sendzad -> local MySQL/MariaDB
                       -> verifier API -> 127.0.0.1:8095 Go service
Cron/systemd -> PHP sending worker -> configured SMTP providers
Cron/systemd -> verification adapter -> verifier API -> DNS / recipient MX :25
```

The separate verification service was an isolation/deployment choice, not a
requirement to buy two machines. Keep it as a separate unprivileged process even
on the same machine: an SMTP timeout should not occupy a web request indefinitely.
Use separate queue locks and resource limits. A single host is simpler but shares
one outage/resource boundary. Keep backups OFF this server and test restoration.

## Mandatory host capabilities
- Permission to run the Go executable persistently (systemd or an equivalent
  supervisor), PHP-FPM and separate bounded PHP cron jobs.
- Provider-permitted outbound port 25 for recipient-server checks; normal SMTP
  submission ports 465/587 are different. Do not bypass host restrictions.
- HTTPS, appropriate domain identity and forward/reverse DNS for the verifier.
- PHP DOM, PDO MySQL, OpenSSL, cURL, mbstring and the application's dependencies.
- MySQL and verifier bound only to loopback/Unix sockets. Restrict phpMyAdmin by
  VPN, tunnel or administrator access controls; it is a database tool, not runtime.

Ordinary shared cPanel hosting may allow PHP/MySQL/cron but disallow persistent
Go processes or direct port 25. The provider must confirm these privileges. On a
VPS with appropriate permissions there is no architectural obstacle to one host.
Cloudflare's original TypeScript/D1 app is a different runtime; moving that app's
SMS/WhatsApp data into the PHP edition still requires its separate migration.

## Setup order
Use the application installation guide for PHP/database/admin setup, then the
existing verifier service guide for Go, a private token file, HELO and TLS settings.
The accompanying Caddy example routes two names to services on the same machine.
An authenticated HTTPS verifier origin remains useful even on one host; it avoids
weakening destination validation to accept arbitrary local URLs.

Use PHP cron jobs for `private/bin/worker.php send` and `... verify` at a cadence
permitted by the host. **The published PHP verification adapter still uses Reoon**
until the separate self-engine adapter is integrated and accepted. Installing a
Go service or this UI update alone does not switch that code path or existing jobs.
Never mark the engine live/default based only on its health endpoint. Run the
existing `services/email-verifier/acceptance.py` with authorized known-valid and
known-invalid cases on this host first. Do not start real campaigns for a UI test.

Sources (reviewed 2026-11-02):
https://docs.cpanel.net/whm/security-center/smtp-restrictions/
https://support.cpanel.net/hc/en-us/articles/360041074753-Why-is-port-25-blocked
https://docs.cpanel.net/cpanel/advanced/cron-jobs/
