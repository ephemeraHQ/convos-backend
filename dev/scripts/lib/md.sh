#!/usr/bin/env bash
# Markdown emit helpers.
# Requires: RUNBOOK exported (target file path).

emit() {
  # Write a literal markdown line/paragraph + blank line after.
  printf '%s\n\n' "$1" >> "$RUNBOOK"
}

emit_code() {
  # Write a single-line shell command in a fenced code block.
  # shellcheck disable=SC2016
  printf '```bash\n$ %s\n```\n\n' "$1" >> "$RUNBOOK"
}

emit_code_block() {
  # Write a multi-line code block. Args: language, content.
  local lang="$1"
  local content="$2"
  # shellcheck disable=SC2016
  printf '```%s\n%s\n```\n\n' "$lang" "$content" >> "$RUNBOOK"
}

emit_check() {
  # Write a check-mark assertion line.
  printf '✅ %s\n\n' "$1" >> "$RUNBOOK"
}

emit_fail() {
  # Write a fail-mark assertion line.
  printf '❌ %s\n\n' "$1" >> "$RUNBOOK"
}
