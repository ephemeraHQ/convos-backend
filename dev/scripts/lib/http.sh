#!/usr/bin/env bash
# HTTP helpers for the E2E demo.
# Requires: BASE_URL, RUNBOOK, TMP exported.
# Sets globals: LAST_STATUS, LAST_BODY, LAST_HEADERS.

run_curl() {
  # Args: title (string for runbook), then standard curl args.
  # Writes the curl invocation to the runbook, runs it, captures status + body + headers.
  local title="$1"
  shift

  local headers_file="$TMP/last_headers"
  local body_file="$TMP/last_body"
  : > "$headers_file"
  : > "$body_file"

  # Echo the command (minus our flags) to the runbook.
  emit "**$title**"
  emit_code "curl ${*}"

  # Run curl. We need: status, headers, body.
  LAST_STATUS=$(curl -sS -o "$body_file" -D "$headers_file" -w '%{http_code}' "$@" || echo "000")
  LAST_BODY=$(cat "$body_file")
  LAST_HEADERS=$(cat "$headers_file")

  # Echo the response into the runbook.
  emit_code_block "" "HTTP $LAST_STATUS
$LAST_HEADERS
$LAST_BODY"
}
