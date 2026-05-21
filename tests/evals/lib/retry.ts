/**
 * Bounded retry with exponential backoff + jitter for transient OpenRouter
 * failures (429 / 5xx / network).
 *
 * Why this exists: qwen3.5-plus (and other models with a single, capacity-limited
 * upstream provider) returns 429 under sustained eval load. Generation is
 * serialized through a promise chain that paces calls by *completion* time — but
 * a 429 returns instantly, so without a delay one throttle cascades into a burst
 * of back-to-back failures. Retrying with backoff both recovers the transient
 * failure (no unfairly-zeroed data points) and re-paces the serialized queue.
 *
 * Scope: transient infra only. A malformed-JSON / schema failure is a model
 * quality signal, not infra, so it is NOT retried — it should count against the
 * model.
 */

/** A definite, terminal failure (e.g. a model quality / parse error). Never
 *  retried, regardless of message content — so embedded model output can't
 *  accidentally trigger a retry. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// Status codes are anchored to our known error-message prefixes ("OpenRouter API
// error 429", "Judge HTTP 503: …") so a stray "503"/"429" inside *model output*
// embedded in an error message can't match. Network tokens are specific enough
// to be safe on their own.
const RETRYABLE =
  /(?:OpenRouter API error|Judge HTTP)\s*(?:429|408|425|5\d\d)\b|Connection error|fetch failed|terminated|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i;

export function isRetryableError(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  return RETRYABLE.test(err instanceof Error ? err.message : String(err));
}

export interface RetryOptions {
  /** Max additional attempts after the first. Default 4. */
  retries?: number;
  /** Base delay in ms. Default 1000. */
  baseMs?: number;
  /** Backoff multiplier. Default 2. */
  factor?: number;
  /** Cap on a single backoff in ms. Default 20000. */
  maxMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    retries = 4,
    baseMs = 1000,
    factor = 2,
    maxMs = 20_000,
    isRetryable = isRetryableError,
    onRetry,
  } = opts;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * factor ** attempt);
      // Jitter across [50%, 100%] of the backoff so concurrent retries spread.
      const delayMs = backoff * (0.5 + Math.random() * 0.5);
      onRetry?.(err, attempt + 1, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
      attempt++;
    }
  }
}
