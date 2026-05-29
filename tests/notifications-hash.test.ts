import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { hashApnsToken, hashTopicSet } from "@/notifications/hash";

/**
 * The hash routine in `src/notifications/hash.ts` MUST match iOS's
 * `PushTopicHash` byte-for-byte. iOS computes the hash and sends it
 * (implicitly via the topic set + token); backend recomputes here and
 * compares against the snapshot row. A divergence between the two would
 * silently break subscribe idempotency, causing either redundant XMTP
 * server calls or (worse) skipped re-applies after legitimate state
 * changes.
 *
 * These tests pin the canonical form (sorted + LF-joined + SHA-256 hex
 * lowercase) so any future refactor breaks here instead of breaking in
 * prod.
 */
describe("hashTopicSet", () => {
  test("empty topic set is deterministic and matches manual SHA-256 of empty string", () => {
    const expected = createHash("sha256").update("", "utf8").digest("hex");
    expect(hashTopicSet([])).toBe(expected);
  });

  test("single-topic case produces SHA-256 of just that topic", () => {
    const topic = "welcome:abc123";
    const expected = createHash("sha256").update(topic, "utf8").digest("hex");
    expect(hashTopicSet([topic])).toBe(expected);
  });

  test("multi-topic case sorts before hashing", () => {
    // The two orderings must produce the SAME hash.
    const ordering1 = ["c", "a", "b"];
    const ordering2 = ["a", "b", "c"];
    expect(hashTopicSet(ordering1)).toBe(hashTopicSet(ordering2));
  });

  test("the canonical join is LF, not CRLF (a CRLF input would hash differently)", () => {
    // Cross-stack invariant: iOS joins with "\n", not "\r\n". Pin this.
    const topics = ["topic1", "topic2"];
    const expectedCanonical = "topic1\ntopic2";
    const expected = createHash("sha256")
      .update(expectedCanonical, "utf8")
      .digest("hex");
    expect(hashTopicSet(topics)).toBe(expected);

    // A CRLF join MUST produce a different hash (sanity-check the spec).
    const crlfCanonical = "topic1\r\ntopic2";
    const crlfHash = createHash("sha256")
      .update(crlfCanonical, "utf8")
      .digest("hex");
    expect(crlfHash).not.toBe(expected);
  });

  test("output is lowercase hex (no uppercase, no 0x prefix, no buffer junk)", () => {
    const hex = hashTopicSet(["one", "two", "three"]);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("preserves input order safety - input array is not mutated", () => {
    const input = ["z", "a", "m"];
    const inputCopy = [...input];
    hashTopicSet(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("hashApnsToken", () => {
  test("returns the 'none' sentinel for null", () => {
    expect(hashApnsToken(null)).toBe("none");
  });

  test("returns the 'none' sentinel for undefined", () => {
    expect(hashApnsToken(undefined)).toBe("none");
  });

  test("returns the 'none' sentinel for empty string", () => {
    expect(hashApnsToken("")).toBe("none");
  });

  test("hashes a real-looking token to lowercase hex SHA-256", () => {
    const fakeToken =
      "d7b7db3b80b3e9e26d4aea7cfcd9d6b9e928188f45113f9edfd9948f";
    const expected = createHash("sha256")
      .update(fakeToken, "utf8")
      .digest("hex");
    expect(hashApnsToken(fakeToken)).toBe(expected);
    expect(hashApnsToken(fakeToken)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("'none' sentinel and a real hash never collide", () => {
    const realHash = hashApnsToken("some-real-token");
    expect(realHash).not.toBe("none");
    expect(realHash.length).toBe(64);
  });
});
