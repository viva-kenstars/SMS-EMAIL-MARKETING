# Enterprise workspace validation - 2026-11-02

## Executed
- Browser interaction/responsive suite: 67 passed, 0 failed; no uncaught page errors.
- Includes independent template save/reopen, editable header/footer, colour inspector,
  section add/duplicate/remove, image insertion, unsafe URL rejection, HTML editing,
  preview sanitization, saved history/restore, campaign-copy workflow, duplicate and
  archive/restore, four separate email-settings views, and brand-only settings save.
- Layout checks: seven routes at 360, 390, 768, 1024 and 1440 pixels; no document overflow.
- New PHP unit checks: 9 passed, 0 failed. Five DOM-dependent checks explicitly skipped.
- All six changed/new PHP files passed PHP syntax validation. New JavaScript modules
  and the generated workspace entry passed Node syntax validation.
- Desktop/mobile screenshots rendered from the implementation were visually reviewed.

Browser tests use the real new frontend module against a synthetic, browser-local
store and a reconstructed PHP frontend fixture derived from the attached candidate
and retrieved engineering source. This is not a complete fresh-clone acceptance run.
The current base workspace.js is preserved in GitHub; build_workspace.py asserts
its integration anchors before generating the new entry. All external image requests
were blocked during browser tests. Fixture records are not live account data.

## Not executed / not passing evidence
- Authenticated PHP HTTP endpoint tests and actual MySQL template persistence.
- Five PHP DOM sanitizer/footer cases (DOM extension unavailable here).
- Disposable MySQL integration suite: NOT RUN, exit 2; DOM/PDO MySQL unavailable.
- Full fresh engineering-checkout build or complete existing regression suites.
- Actual Gmail/Outlook rendering, SMTP submission, signed callback or host cron tests.
- One-server installation, independent-verifier default switch, or live deployment.

## Commands on a suitable clean staging checkout
python3 shared-hosting/scripts/build_release.py
php shared-hosting/private/tests/enterprise-unit.php
python3 shared-hosting/private/tests/enterprise-browser.py

For the SQL suite use a disposable database ending in _test, with the test-only
SENDZAD_TEST_DSN / SENDZAD_TEST_DB_USER / SENDZAD_TEST_DB_PASSWORD settings, then:
SENDZAD_TEST_RESET=1 php shared-hosting/private/tests/saved-templates-integration.php

The integration runner deliberately resets tz_ tables only in that authorized
_test database. Never point it at production. No campaigns or verification probes
were launched in this update. Apply the additive migration and complete target-host
acceptance before deploying this PHP edition. The existing Cloudflare Site is unchanged.
