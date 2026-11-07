#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
export SENDZAD_AUDIT_FIXTURES="$TMP/engine-results.json"
(cd "$ROOT/services/email-verifier" && go test -race -count=1 ./... && go vet ./...)
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then TSC="$ROOT/node_modules/.bin/tsc"; else TSC=tsc; fi
"$TSC" "$ROOT/app/lib/email/self-hosted.ts" --strict --target ES2022 --module commonjs --lib ES2022,DOM --outDir "$TMP/js"
export SENDZAD_AUDIT_TS_MODULE="$TMP/js/self-hosted.js"
node --test "$ROOT/tests/verifier-audit.test.mjs"
php "$ROOT/shared-hosting/private/tests/verifier-audit.php"
node --check "$ROOT/shared-hosting/public/assets/verification-connection.js"
for NAME in VerifierSetup SelfVerifier VerifierWorker; do php -l "$ROOT/shared-hosting/private/app/$NAME.php"; done
php -l "$ROOT/shared-hosting/private/bin/verifier-doctor.php"
php -l "$ROOT/shared-hosting/private/bin/worker.php"
