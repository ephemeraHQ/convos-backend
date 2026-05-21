/**
 * Offline unit tests for retry/backoff classification + control flow. No network.
 */

import { describe, expect, test } from "bun:test";
import { isRetryableError, withRetry } from "./lib/retry";

describe("isRetryableError", () => {
  test("429 / 5xx / rate-limit / network are retryable", () => {
    for (const m of [
      "OpenRouter API error 429",
      "Judge HTTP 503: upstream",
      "rate limit exceeded",
      "Provider overloaded",
      "fetch failed",
      "ETIMEDOUT",
    ]) {
      expect(isRetryableError(new Error(m))).toBe(true);
    }
  });

  test("4xx (non-429) and quality errors are NOT retryable", () => {
    for (const m of [
      "Judge HTTP 400: bad schema",
      "OpenRouter API error 401",
      "Failed to parse JSON",
      "LLM response missing prompt",
    ]) {
      expect(isRetryableError(new Error(m))).toBe(false);
    }
  });
});

describe("withRetry", () => {
  const fast = { baseMs: 1, maxMs: 4 };

  test("returns immediately on success (no retry)", async () => {
    let calls = 0;
    const out = await withRetry(() => {
      calls++;
      return Promise.resolve("ok");
    }, fast);
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries a retryable error, then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      () =>
        ++calls < 3
          ? Promise.reject(new Error("OpenRouter API error 429"))
          : Promise.resolve(calls),
      fast,
    );
    expect(out).toBe(3);
    expect(calls).toBe(3);
  });

  test("gives up after `retries` attempts and throws the last error", async () => {
    let calls = 0;
    let err: unknown;
    try {
      await withRetry(
        () => {
          calls++;
          return Promise.reject(new Error("503 overloaded"));
        },
        { ...fast, retries: 2 },
      );
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/503/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("does not retry a non-retryable error", async () => {
    let calls = 0;
    let err: unknown;
    try {
      await withRetry(() => {
        calls++;
        return Promise.reject(new Error("Judge HTTP 400: bad schema"));
      }, fast);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/400/);
    expect(calls).toBe(1);
  });
});
