# Sendzad shared-hosting candidate

Editable PHP/MySQL email-campaign implementation with an enterprise dashboard, configurable sender branding, 16 marketing templates with illustrative photographs, 10 reusable content sections, SMTP accounts and rotation, verification jobs, unsubscribe handling and evidence-based reports.

This is a candidate for a separate PHP host. It does not run in the original Cloudflare Site and does not migrate existing SMS/WhatsApp features or saved verification jobs.

## Build

From the repository root:

```sh
python3 shared-hosting/scripts/build_release.py
cd shared-hosting/private
composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction
composer audit
```

The Python step runs at build time only. Generated assets must ship together with the PHP and JavaScript sources. Composer installs the pinned PHPMailer transport; vendor dependencies are not part of the editable source tree.

## Hosting

Use PHP 8.2 or newer with PDO MySQL, DOM, cURL, OpenSSL and mbstring; MySQL/MariaDB; HTTPS; cron; and permitted outbound authenticated SMTP. phpMyAdmin administers the database; it does not replace these runtime requirements.

Keep `private/` outside the public document root. Point the subdomain document root to `public/`. Copy `private/config.example.php` to private/config.php and fill the real values privately. Preserve the existing stable application key during updates. The SQL schema is for a NEW installation, not an automatic D1 migration. Do not import it over existing production data.

Create an admin with `php shared-hosting/private/bin/create-admin.php`. On hosts without terminal access, the admin-sql helper can be run on a trusted development computer and its hashed-password SQL imported through phpMyAdmin. Never publish that SQL.

Create separate cron entries for `private/bin/worker.php verify` and `private/bin/worker.php send`, at a cadence allowed by the host. Verification advances only explicitly started jobs in this installation. Sending advances only explicitly launched campaigns. Neither operation is invoked by the build workflow.

Remove public/preview.html and public/assets/demo.js from a production upload. They are sample-data preview tools, not the authenticated backend.

## Important boundaries

- Source branding is Sendzad; outgoing emails use the business identity in Settings.
- Stock photographs are illustrative and externally hosted. Confirm image licensing, content and product relevance before sending.
- SMTP acceptance is not confirmed recipient delivery. Supported provider events can confirm delivery; opens/clicks are estimates and not proof of reading.
- Preflight guards prevent unfinished sample offers and links from being launched.
- Existing database table prefixes and signed-data markers remain stable for compatibility.
- This source recovery is not a live deployment or a production-readiness certification.

## Verification

```sh
php shared-hosting/private/tests/unit.php
php shared-hosting/private/tests/templates.php
php shared-hosting/private/tests/sendzad.php
```

MySQL integration tests require a disposable database ending `_test` and explicit SENDZAD_TEST_RESET=1. Browser tests use synthetic data. Real SMTP, provider callbacks, target-host cron and actual inbox rendering require separate controlled acceptance tests.
