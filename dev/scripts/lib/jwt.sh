#!/usr/bin/env bash
# JWT helpers.

decode_jwt_payload() {
  # Decode the middle segment of a JWT (base64url) and pretty-print as JSON.
  local jwt="$1"
  local payload
  payload=$(printf '%s' "$jwt" | cut -d. -f2)
  # base64url → base64: replace -_ with +/, then pad with '=' to length % 4.
  local b64="${payload//-/+}"
  b64="${b64//_//}"
  local rem=$(( ${#b64} % 4 ))
  if [[ $rem -ne 0 ]]; then
    b64="${b64}$(printf '%*s' $((4 - rem)) '' | tr ' ' '=')"
  fi
  printf '%s' "$b64" | base64 -d 2>/dev/null | jq .
}
