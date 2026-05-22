/**
 * Fire-and-forget revalidation of the assistants-dashboard Next.js cache.
 *
 * The dashboard (assistants.convos.org) reads agent-templates from
 * `/api/v2/agent-templates*` via Next.js Data Cache with a 60s TTL,
 * tagged `templates` and `template:<idOrHashedSlug>`. It exposes
 * `POST /api/revalidate` (auth: `Authorization: Bearer <secret>`,
 * body: `{ tags: string[] }`) so callers can drop tagged entries on
 * demand.
 *
 * Configuration:
 *   - BUILDER_SITE_URL              — dashboard base URL (reused; same env
 *                                     var the builder uses for share links)
 *   - BUILDER_REVALIDATE_SECRET  — shared bearer; service no-ops when unset
 *
 * Contract:
 *   - Best-effort: never throws. Errors are logged at warn and swallowed.
 *   - 3-second hard timeout via AbortController so a slow dashboard cannot
 *     stall an HTTP handler that fires this from its hot path.
 *   - The dashboard's 60s TTL is the fallback when this call drops.
 */

import { BUILDER_REVALIDATE_SECRET, BUILDER_SITE_URL } from "@/config";
import logger from "@/utils/logger";
import { buildUrlSlug } from "@/utils/url-slug";

const REVALIDATE_TIMEOUT_MS = 3_000;

// Test seams — let the test suite stub fetch + override the secret/base URL
// without monkey-patching globalThis or reloading the config module.
type FetchLike = typeof fetch;
let _fetchOverride: FetchLike | null = null;
let _secretOverride: string | null | undefined = undefined;
let _baseUrlOverride: string | null | undefined = undefined;

export function __setFetchForTests(fn: FetchLike | null): void {
  _fetchOverride = fn;
}

/** Pass a string to override, `null` to simulate "unset", `undefined` to
 *  clear and fall back to BUILDER_REVALIDATE_SECRET from config. */
export function __setSecretForTests(value: string | null | undefined): void {
  _secretOverride = value;
}

/** Pass a string to override, `null` to simulate "unset", `undefined` to
 *  clear and fall back to BUILDER_SITE_URL from config. */
export function __setBaseUrlForTests(value: string | null | undefined): void {
  _baseUrlOverride = value;
}

function currentFetch(): FetchLike {
  return _fetchOverride ?? fetch;
}

function currentSecret(): string {
  if (_secretOverride !== undefined) return _secretOverride ?? "";
  return BUILDER_REVALIDATE_SECRET;
}

function currentBaseUrl(): string {
  if (_baseUrlOverride !== undefined) return _baseUrlOverride ?? "";
  return BUILDER_SITE_URL;
}

/**
 * Fire a tag revalidation against the dashboard. Resolves once the request
 * completes (or has been swallowed). Caller may `void` the returned promise
 * to keep the request path off the critical path.
 */
export async function revalidateDashboardTags(args: {
  tags: readonly string[];
  log?: Pick<typeof logger, "warn" | "info">;
}): Promise<void> {
  const log = args.log ?? logger;

  if (args.tags.length === 0) return;

  const secret = currentSecret();
  if (!secret) {
    // Unset secret means revalidation is intentionally disabled (local dev,
    // tests). Stay quiet: this fires from every template mutation and the
    // 60s TTL covers the gap.
    return;
  }

  const baseUrl = currentBaseUrl();
  if (!baseUrl) return;

  const url = `${baseUrl.replace(/\/+$/, "")}/api/revalidate`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, REVALIDATE_TIMEOUT_MS);

  try {
    const response = await currentFetch()(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ tags: args.tags }),
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(
        {
          status: response.status,
          tags: args.tags,
          url,
        },
        "[revalidate-dashboard] non-2xx response",
      );
    }
  } catch (err) {
    log.warn(
      { err, tags: args.tags, url },
      "[revalidate-dashboard] request failed",
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Convenience wrapper: fire the tag set the dashboard uses for a single
 * template — `templates` (list/featured surface), `template:<id>`, and
 * `template:<base>.<hash>` (the url-slug form the dashboard's
 * `/a/[urlSlug]` page tags by). `args.slug` is the BASE slug; the url slug
 * is derived with the same `buildUrlSlug` that serializes `publishedUrl`,
 * so the tag matches what the dashboard keyed its fetch on.
 */
export function revalidateTemplate(args: {
  id: string;
  slug: string;
  log?: Pick<typeof logger, "warn" | "info">;
}): Promise<void> {
  const tags = [
    "templates",
    `template:${args.id}`,
    `template:${buildUrlSlug(args.slug, args.id)}`,
  ];
  return revalidateDashboardTags({ tags, log: args.log });
}
