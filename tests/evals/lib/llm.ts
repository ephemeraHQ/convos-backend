/**
 * Minimal OpenRouter JSON-completion helper for the judge.
 *
 * Deliberately separate from the product's openrouter-client.ts: judge calls
 * must NOT flow through the @posthog/ai wrapper (we don't want eval judging to
 * land in product LLM-analytics traces), and the judge needs a strict
 * json_schema response with no provider routing. A direct fetch keeps the eval
 * self-contained.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Per-call wallclock cap for judge requests; override via env for slow models
 *  (e.g. in CI). Falls back to 120s. */
const DEFAULT_JUDGE_TIMEOUT_MS =
  Number(process.env.EVAL_JUDGE_TIMEOUT_MS) || 120_000;

/** The judge can use a dedicated key, else fall back to the builder key. */
export function judgeApiKey(): string {
  return (
    process.env.EVAL_OPENROUTER_API_KEY?.trim() ||
    process.env.BUILDER_OPENROUTER_API_KEY?.trim() ||
    ""
  );
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Tolerate a fenced or prose-wrapped object, mirroring templateGen's
    // parser fallback.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Judge response was not JSON: ${content.slice(0, 200)}`);
    }
    return JSON.parse(match[0]) as unknown;
  }
}

export interface OpenRouterJSONOptions {
  model: string;
  system: string;
  user: string;
  /** A JSON Schema object for response_format json_schema (strict). */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Default 0 — judging should be as deterministic as the model allows. */
  temperature?: number;
  timeoutMs?: number;
}

/** Returns the parsed JSON as `unknown`; callers cast to their schema's shape
 *  (the strict json_schema response_format enforces it server-side). */
export async function openRouterJSON(
  opts: OpenRouterJSONOptions,
): Promise<unknown> {
  const apiKey = judgeApiKey();
  if (!apiKey) {
    throw new Error(
      "Judge API key missing: set EVAL_OPENROUTER_API_KEY or BUILDER_OPENROUTER_API_KEY",
    );
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature ?? 0,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: opts.schemaName,
          strict: true,
          schema: opts.schema,
        },
      },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Judge HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Judge returned no message content");
  }
  return parseJson(content);
}
