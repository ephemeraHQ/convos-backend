/**
 * Offline unit tests for retry/backoff classification + control flow. No network.
 */

import { describe, expect, test } from "vitest";
import { isRetryableError, NonRetryableError, withRetry } from "./lib/retry";

describe("isRetryableError", () => {
  test("our transient HTTP + network errors are retryable", () => {
    for (const m of [
      "OpenRouter API error 429",
      "OpenRouter API error 503",
      "Judge HTTP 429: too many requests",
      "Judge HTTP 503: upstream",
      "fetch failed",
      "Connection error",
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

  test("a status/rate token embedded in model text is NOT retryable (anchored)", () => {
    // Status codes only match when prefixed by our own error wording; "rate
    // limit"/"overloaded" aren't matched at all. So a malformed model response
    // quoting these can't look retryable.
    expect(
      isRetryableError(
        new Error("LLM output mentioned 503, rate limit, and overloaded"),
      ),
    ).toBe(false);
  });

  test("NonRetryableError is never retried, even if its message embeds tokens", () => {
    const e = new NonRetryableError(
      'Judge response was not JSON: {"idea":"a 429 / 503 rate-limit fetch-failed monitor"}',
    );
    expect(isRetryableError(e)).toBe(false);
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
          return Promise.reject(new Error("OpenRouter API error 503"));
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

  test("does not retry a NonRetryableError even with retry tokens in the message", async () => {
    let calls = 0;
    let err: unknown;
    try {
      await withRetry(() => {
        calls++;
        return Promise.reject(
          new NonRetryableError("malformed: contains 429 and 503"),
        );
      }, fast);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/malformed/);
    expect(calls).toBe(1);
  });
});
