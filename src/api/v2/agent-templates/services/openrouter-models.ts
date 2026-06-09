/**
 * OpenRouter model-catalog lookup — used to validate a caller-supplied
 * `builderModel` at submit time so an unknown model id fails fast with a 400
 * instead of surfacing later as a terminal `failed` generation.
 *
 * The catalog (`GET /models`) is public and changes infrequently, so the id
 * set is cached in-process with a TTL. Validation is best-effort: if the
 * catalog can't be fetched and nothing is cached yet, `isKnownOpenRouterModel`
 * fails open (returns true) so a transient OpenRouter outage doesn't block
 * custom-model submissions — the async generation path remains the backstop.
 */

import { OPENROUTER_BASE_URL } from "@/api/v2/agent-templates/services/openrouter-client";
import logger from "@/utils/logger";

const MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5_000;

interface ModelCache {
  ids: Set<string>;
  fetchedAt: number;
}

let _cache: ModelCache | null = null;
let _testOverride: Set<string> | null = null;

/** Inject a fixed model-id set for tests, bypassing the network fetch. Pass
 *  `null` to clear the override (and the cache). */
export function __setOpenRouterModelsForTests(ids: string[] | null): void {
  _testOverride = ids ? new Set(ids) : null;
  _cache = null;
}

async function fetchModelIds(): Promise<Set<string>> {
  const res = await fetch(MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = new Set<string>();
  for (const model of json.data ?? []) {
    if (typeof model.id === "string") ids.add(model.id);
  }
  if (ids.size === 0) {
    throw new Error("OpenRouter /models returned no model ids");
  }
  return ids;
}

/**
 * True when `model` is a known OpenRouter model id. Best-effort: returns true
 * when the catalog can't be fetched and no cached set exists yet (fail-open);
 * a stale cache is preferred over failing open when a refresh fails.
 */
export async function isKnownOpenRouterModel(model: string): Promise<boolean> {
  if (_testOverride) return _testOverride.has(model);

  const now = Date.now();
  if (!_cache || now - _cache.fetchedAt > CACHE_TTL_MS) {
    try {
      _cache = { ids: await fetchModelIds(), fetchedAt: now };
    } catch (err) {
      logger.warn({ err }, "[openrouter-models] catalog fetch failed");
      // No catalog at all → can't validate, so don't block the submission.
      if (!_cache) return true;
      // Otherwise fall through and validate against the stale cache.
    }
  }
  return _cache.ids.has(model);
}
