#!/usr/bin/env bash
#
# CON-825 preview slim-secret boot contract.
#
# Starts the REAL container entrypoint (dev/entrypoint.sh, via APP_DIR) with
# nothing but the environment variables convos-backend requires SYNTACTICALLY AT
# BOOT, plus the preview-only pair, and asserts that:
#
#   * the connect-wait, `prisma migrate deploy` and `prisma db seed` steps all
#     run and the server reaches a serving state;
#   * the preview seed wrote its marker and turned App Check off;
#   * `X-Preview-Token` gates everything except exactly /healthcheck.
#
# The `export` block below IS the contract. Adding a new module-load `throw` to
# src/config.ts (or a new required knob to src/payments/credits/config.ts)
# without adding it here fails this check — which is the point. Everything
# deliberately NOT listed here (FIREBASE_SERVICE_ACCOUNT, AGENT_ASSETS_API_KEY,
# COMPOSIO_*, APPLE_*, GOOGLE_PLAY_*, POSTHOG_*, the S3 buckets, CDN_BASE_URL,
# DEV_API_TOKEN, CREDITS_ADMIN_API_TOKEN, LIFECYCLE_TEST_*) is semantic and
# per-path: its endpoint 503s, the server boots.
#
# Requires: a reachable DATABASE_URL, `psql`, `curl`, and a prior `pnpm build`.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::preview-boot-check: DATABASE_URL must be set" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APP_DIR
cd "$APP_DIR"

if [ ! -f "$APP_DIR/dist/index.js" ] || [ ! -f "$APP_DIR/dist/db-wait.js" ]; then
  echo "::error::preview-boot-check: dist/ is missing — run 'pnpm build' first" >&2
  exit 1
fi

PORT=4141
BASE="http://127.0.0.1:${PORT}"
export PORT

# --- preview-only ----------------------------------------------------------
export PREVIEW=1
export PREVIEW_TOKEN="preview-boot-check-token-0123456789abcdef0123456789abcdef"

# --- THE SLIM SET: required syntactically at boot ---------------------------
export XMTP_NOTIFICATION_SECRET="preview-boot-check-notification-secret"
export NOTIFICATION_SERVER_URL="http://127.0.0.1:8080"
# Must be https:// or a localhost / *.test.local host — src/config.ts rejects
# plaintext anywhere else.
export ASSISTANT_API_URL="https://assistants.test.local"
export SIWE_DOMAIN="preview.convos.org"
export SIWE_URI="https://preview.convos.org"
# >= 64 chars or src/config.ts throws.
export NONCE_HMAC_SECRET="0000000000000000000000000000000000000000000000000000000000000000"
export BUILDER_SITE_URL="https://preview.convos.org"
export PAYMENTS_MARKUP_RATE="2.0"
export PAYMENTS_CREDITS_PER_USD="1000"
export PAYMENTS_RESERVED_MAX_TURN_CREDITS="1"
export PAYMENTS_MIN_BALANCE_CREDITS="-1000"
export PAYMENTS_GRANT_PLUS_MONTHLY="2500"
# Public throwaway ECDSA P-256 pair — the same one tests/setup.ts uses.
export JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGis9E4WiE4Ou51Ho
2tH6goYKt2nxLsKgadVvCYaklRyhRANCAARIw/oKiY4bkkW8iOcgiyUb1XPOtBQ4
/7NXGEExhSwpySP8P8tpOUlKoI2DryaYFx4EJhqtnV3Dhp1wLcxDKZYG
-----END PRIVATE KEY-----"
export JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESMP6ComOG5JFvIjnIIslG9VzzrQU
OP+zVxhBMYUsKckj/D/LaTlJSqCNg68mmBceBCYarZ1dw4adcC3MQymWBg==
-----END PUBLIC KEY-----"

# --- operational, mirroring the ECS task definition ------------------------
export NODE_ENV=production
export XMTP_ENV=dev
export LOG_FORMAT=json
# The OTel SDK is left ENABLED even though no collector is listening: previews
# ship without Datadog sidecars, so "the app survives an unreachable OTLP
# endpoint" is exactly the behaviour worth proving. Expect noisy export errors.

SERVER_PID=""

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # Never leave app_attest_enabled=false (or the marker) behind: a later test
  # run against the same database would silently have App Check disabled.
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || true
DELETE FROM "AgentTemplate" WHERE id = '22222222-2222-4222-8222-222222222222';
DELETE FROM "UserCredits" WHERE "accountId" = '11111111-1111-4111-8111-111111111111';
DELETE FROM "Account" WHERE id = '11111111-1111-4111-8111-111111111111';
DELETE FROM "InviteCode" WHERE code IN ('PREVIEW1','PREVIEW2','PREVIEW3');
DELETE FROM "RuntimeConfig" WHERE key IN ('preview_seeded','app_attest_enabled');
SQL
  # Verify rather than trust: a swallowed psql failure that leaves
  # app_attest_enabled=false behind would silently disable App Check for every
  # later run against this database, and a green job would hide it. Only ever
  # escalates — an already-failing run keeps its original status.
  local leftover
  leftover="$(psql "$DATABASE_URL" -tAc \
    "SELECT count(*) FROM \"RuntimeConfig\" WHERE key IN ('preview_seeded','app_attest_enabled')" \
    2>/dev/null)" || leftover="unknown"
  if [ "$leftover" != "0" ]; then
    echo "::error::preview-boot-check: cleanup failed to remove the seeded rows (leftover=${leftover}); app_attest_enabled may still be 'false' in this database" >&2
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "::error::preview-boot-check: $1" >&2
  exit 1
}

assert_status() {
  local expected="$1"
  local desc="$2"
  shift 2
  local actual
  actual="$(curl -s -o /dev/null -w '%{http_code}' "$@" || true)"
  if [ "$actual" != "$expected" ]; then
    fail "${desc} — expected HTTP ${expected}, got ${actual}"
  fi
  echo "  ok: ${desc} -> ${actual}"
}

echo "preview-boot-check: starting dev/entrypoint.sh (APP_DIR=$APP_DIR PORT=$PORT)"
./dev/entrypoint.sh &
SERVER_PID=$!

ready=""
for i in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "the entrypoint exited before the server became ready (see log above)"
  fi
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/healthcheck" || true)" = "200" ]; then
    ready="yes"
    echo "preview-boot-check: serving after ${i}s"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail "server did not become healthy within 120s on the slim env set"

echo "preview-boot-check: asserting the X-Preview-Token gate"
assert_status 200 "/healthcheck is exempt with no token" "${BASE}/healthcheck"
assert_status 200 "/healthcheck?container=true is exempt (query string ignored)" \
  "${BASE}/healthcheck?container=true"
assert_status 401 "/healthcheck/details is NOT exempt" "${BASE}/healthcheck/details"
assert_status 401 "/api/v2/agent-templates without a token" \
  "${BASE}/api/v2/agent-templates"
assert_status 401 "/api/v2/agent-templates with a wrong token" \
  -H "X-Preview-Token: wrong-token-that-is-also-32-characters-long" \
  "${BASE}/api/v2/agent-templates"
assert_status 200 "/api/v2/agent-templates with the right token" \
  -H "X-Preview-Token: ${PREVIEW_TOKEN}" \
  "${BASE}/api/v2/agent-templates"

echo "preview-boot-check: asserting the preview seed ran"
marker="$(psql "$DATABASE_URL" -tAc \
  "SELECT value FROM \"RuntimeConfig\" WHERE key = 'preview_seeded'")"
[ -n "$marker" ] || fail "the preview seed did not write the 'preview_seeded' marker"
echo "  ok: preview_seeded = ${marker}"

attest="$(psql "$DATABASE_URL" -tAc \
  "SELECT value FROM \"RuntimeConfig\" WHERE key = 'app_attest_enabled'")"
[ "$attest" = "false" ] || fail "app_attest_enabled is '${attest}', expected 'false'"
echo "  ok: app_attest_enabled = false"

invites="$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM \"InviteCode\" WHERE code IN ('PREVIEW1','PREVIEW2','PREVIEW3')")"
[ "$invites" = "3" ] || fail "expected 3 seeded invite codes, found '${invites}'"
echo "  ok: 3 seeded invite codes"

credits="$(psql "$DATABASE_URL" -tAc \
  "SELECT balance FROM \"UserCredits\" WHERE \"accountId\" = '11111111-1111-4111-8111-111111111111'")"
[ "$credits" = "100000" ] || fail "expected the seeded account to hold 100000 credits, found '${credits}'"
echo "  ok: seeded account has 100000 credits"

echo "preview-boot-check: PASS"
