#!/usr/bin/env bash
# Assertion helpers for the E2E demo.
# Requires: RUNBOOK exported, PASSED_CASES + FAILED_CASES arrays.
# Each helper:
#   - Reads expected vs actual.
#   - Writes ✅/❌ line to the runbook.
#   - Appends to PASSED_CASES or FAILED_CASES.
#   - Returns 0 on pass, 1 on fail.

_record_pass() {
  PASSED_CASES+=("$1")
  emit_check "$1"
}

_record_fail() {
  FAILED_CASES+=("$1")
  emit_fail "$1"
}

assert_status() {
  # Args: case_name, expected_status, actual_status.
  local case_name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    _record_pass "$case_name: status $actual == $expected"
    return 0
  fi
  _record_fail "$case_name: status $actual != expected $expected"
  return 1
}

assert_match() {
  # Args: case_name, regex (egrep), actual.
  local case_name="$1"
  local pattern="$2"
  local actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    _record_pass "$case_name: matches /$pattern/"
    return 0
  fi
  _record_fail "$case_name: '$actual' does not match /$pattern/"
  return 1
}

assert_json_eq() {
  # Args: case_name, jq_path (e.g. .success), expected_json_value (string-form), actual_body.
  local case_name="$1"
  local jq_path="$2"
  local expected="$3"
  local body="$4"
  local got
  got=$(echo "$body" | jq -c "$jq_path" 2>/dev/null) || got=""
  if [[ "$got" == "$expected" ]]; then
    _record_pass "$case_name: $jq_path == $expected"
    return 0
  fi
  _record_fail "$case_name: $jq_path == $got, expected $expected"
  return 1
}

assert_psql_count() {
  # Args: case_name, table_name (raw, will be quoted), expected_count.
  local case_name="$1"
  local table="$2"
  local expected="$3"
  local got
  got=$(psql_query "SELECT count(*) FROM \"$table\"")
  if [[ "$got" == "$expected" ]]; then
    _record_pass "$case_name: count(\"$table\") == $expected"
    return 0
  fi
  _record_fail "$case_name: count(\"$table\") == $got, expected $expected"
  return 1
}

assert_psql_query() {
  # Args: case_name, sql, expected_value (string).
  local case_name="$1"
  local sql="$2"
  local expected="$3"
  local got
  got=$(psql_query_raw "$sql")
  if [[ "$got" == "$expected" ]]; then
    _record_pass "$case_name: query result matches expected"
    return 0
  fi
  _record_fail "$case_name: query returned '$got', expected '$expected'"
  return 1
}

assert_min() {
  # Args: case_name, metric_name, min_expected (int), actual (int).
  local case_name="$1"
  local metric="$2"
  local min="$3"
  local actual="$4"
  if (( actual >= min )); then
    _record_pass "$case_name: $metric=$actual >= $min"
    return 0
  fi
  _record_fail "$case_name: $metric=$actual < min $min"
  return 1
}
