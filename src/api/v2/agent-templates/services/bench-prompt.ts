import { BRAINTRUST_API_KEY } from "@/config";

// The bench prompt store is Braintrust's native versioned Prompts, slug-
// addressable over the public REST API. Variant builder prompts (Axis B) are
// authored there (project "convos-agent-bench") and resolved live at generation
// time — editing a bench prompt takes effect on the next build with no re-push.
const BT_REST = "https://api.braintrust.dev/v1";
const BENCH_PROJECT = "convos-agent-bench";
const REST_TIMEOUT_MS = 15_000;

function restObjects(body: unknown): Record<string, unknown>[] {
  if (typeof body !== "object" || body === null || !("objects" in body)) {
    return [];
  }
  const objs: unknown = body.objects;
  if (!Array.isArray(objs)) return [];
  return objs.filter(
    (o): o is Record<string, unknown> => typeof o === "object" && o !== null,
  );
}

/**
 * Pull the builder text out of a Braintrust `prompt_data` payload — either a
 * completion `content`/`prompt` string or the joined chat `messages`. Pure, so
 * the parsing is unit-testable without hitting the API.
 */
export function extractPromptText(promptData: unknown): string {
  if (typeof promptData !== "object" || promptData === null) return "";
  const p = (promptData as { prompt?: unknown }).prompt;
  if (typeof p !== "object" || p === null) return "";
  const prompt = p as Record<string, unknown>;
  if (typeof prompt.content === "string") return prompt.content;
  if (typeof prompt.prompt === "string") return prompt.prompt;
  if (Array.isArray(prompt.messages)) {
    return prompt.messages
      .map((m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as { content?: unknown }).content === "string"
          ? (m as { content: string }).content
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export type BenchPromptLoader = (slug: string) => Promise<string>;
let _loaderOverride: BenchPromptLoader | null = null;

/**
 * Install a test override for `loadBenchPromptText` (the only network call in
 * this module). Pass `null` to restore normal Braintrust REST behaviour. Mirrors
 * the `__reset*ForTests` seam the other generation services expose, so tests
 * stay hermetic without module mocks.
 */
export function __resetBenchPromptLoaderForTests(
  override: BenchPromptLoader | null,
): void {
  _loaderOverride = override;
}

/**
 * Resolve a bench/Braintrust prompt slug to its latest text. Throws on a missing
 * key, an unreachable/erroring API, an unknown slug, or empty text — the
 * generation seam catches and falls back to the canonical generator, so a
 * variant degrades rather than fails the build.
 */
export async function loadBenchPromptText(slug: string): Promise<string> {
  if (_loaderOverride) {
    return _loaderOverride(slug);
  }
  if (!BRAINTRUST_API_KEY) {
    throw new Error("BRAINTRUST_API_KEY not configured");
  }
  const res = await fetch(
    `${BT_REST}/prompt?project_name=${encodeURIComponent(BENCH_PROJECT)}&slug=${encodeURIComponent(slug)}`,
    {
      headers: { Authorization: `Bearer ${BRAINTRUST_API_KEY}` },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`Braintrust prompt lookup failed (${res.status})`);
  }
  const first = restObjects(await res.json()).at(0);
  if (!first) {
    throw new Error(`bench prompt "${slug}" not found`);
  }
  const text = extractPromptText(first.prompt_data);
  if (!text) {
    throw new Error(`bench prompt "${slug}" carries no text`);
  }
  return text;
}
