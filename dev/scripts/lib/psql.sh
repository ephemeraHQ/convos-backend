#!/usr/bin/env bash
# psql wrapper helpers.
# Requires: PSQL_URL exported.

psql_exec() {
  # Execute a statement, ignore result text. Returns psql's exit code.
  local stmt="$1"
  psql "$PSQL_URL" -tA -v ON_ERROR_STOP=1 -c "$stmt" > /dev/null
}

psql_query() {
  # Execute a query, print single value to stdout. Whitespace trimmed.
  local stmt="$1"
  psql "$PSQL_URL" -tA -v ON_ERROR_STOP=1 -c "$stmt" | tr -d '[:space:]'
}

psql_query_raw() {
  # Execute a query, print result rows as-is (no trimming).
  local stmt="$1"
  psql "$PSQL_URL" -tA -v ON_ERROR_STOP=1 -c "$stmt"
}
