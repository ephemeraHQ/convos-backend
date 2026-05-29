import { createHash } from "node:crypto";

/**
 * Canonical hash routine for push topic sets and APNS tokens. MUST match
 * iOS bit-for-bit so the idempotency check + the debug-status response can
 * compare hashes across the wire without phantom mismatches.
 *
 * Routine:
 * 1. Sort topics lexicographically as UTF-8 strings (default JS string sort
 *    on UTF-16 code units coincides with UTF-8 byte order for the topic
 *    set we use today; if topics ever contain supplementary plane chars
 *    we revisit this).
 * 2. Join with a single LF byte (`\n`, NOT CRLF).
 * 3. SHA-256.
 * 4. Lowercase hex.
 *
 * iOS counterpart: PushTopicHash.of(_:) in
 * ConvosCore/Sources/ConvosCore/Syncing/PushTopicSubscriptionCache.swift
 *
 * Tests cover the empty set, a single topic, and many-topic ordering.
 */
export function hashTopicSet(topics: readonly string[]): string {
  const canonical = [...topics].sort().join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * SHA-256 hex of an APNS token string. Returns the sentinel `"none"` when
 * no token is present so cache / idempotency keys still partition cleanly
 * between the pre-token and post-token states.
 *
 * iOS counterpart: PushTopicHash.ofToken(_:) in
 * ConvosCore/Sources/ConvosCore/Syncing/PushTopicSubscriptionCache.swift
 */
export function hashApnsToken(token: string | null | undefined): string {
  if (!token) {
    return "none";
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
