/**
 * Distill stage — the fast first pass of the generation pipeline.
 *
 * Turns the raw build request into the agent's IDENTITY (agentName, emoji,
 * description) plus `progressPhrases` — the 6–8 short build-narration lines a
 * client rotates while the slow generate stage runs. This is the agent-builder
 * skill's "distill" step moved server-side: the executor writes the result into
 * the generation row's `preview` column so the poll endpoints can surface the
 * identity card + phrases on the early 202 responses, before the full template
 * exists.
 *
 * One OpenRouter call with strict json_schema output, on the builder model
 * (`getModel()` — the distill shares the builder's key + model). The executor
 * runs it best-effort: a distill failure is logged and the pipeline proceeds to
 * generate without phrases / a partial card.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

import { BUILDER_OPENROUTER_API_KEY } from "@/config";
import { loadDataPrompt } from "../lib/data-prompt";
import {
  openRouterChatCompletion,
  type TraceContext,
} from "./openrouter-client";
import {
  decodeEmojiEscapes,
  getModel,
  sanitizeEmojiField,
  type GenerationPrefill,
} from "./templateGen";

// Loaded once at module init (same convention as the generator's SYSTEM_PROMPT).
// Null when the file can't be read — the executor treats that like any other
// distill failure and proceeds without phrases.
const DISTILL_PROMPT = loadDataPrompt("distill-prompt.txt");

// Distill is small (identity + ~6 short lines) so it caps far below the 120s
// main generate call — a hung distill must not eat the pipeline's time budget.
const DISTILL_TIMEOUT_MS = 60_000;

// The schema asks for 6–8 phrases; accept down to this floor after filtering
// blanks so a near-miss still yields a usable badge rather than failing the
// (best-effort) stage. Trim anything over the ceiling.
const MIN_PHRASES = 4;
const MAX_PHRASES = 8;

export interface DistillResult {
  agentName: string;
  emoji: string;
  description: string;
  progressPhrases: string[];
}

// ---------------------------------------------------------------------------
// Config + test seams (mirror templateGen's override pattern)
// ---------------------------------------------------------------------------

let _apiKeyOverride: string | null | undefined = undefined;

function getApiKey(): string | null {
  if (_apiKeyOverride !== undefined) return _apiKeyOverride;
  return BUILDER_OPENROUTER_API_KEY || null;
}

/** Override the OpenRouter API key for tests (the distill stage shares the
 *  builder key). Pass a string to override, `null` to simulate "no key set",
 *  or `undefined` to clear and fall back to config. */
export function __setDistillApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _apiKeyOverride = key;
}

type DistillFn = (
  text: string,
  signal?: AbortSignal,
  prefill?: GenerationPrefill | null,
  trace?: TraceContext,
) => Promise<DistillResult>;

let _distillOverride: DistillFn | null = null;

/** Install a test override for `distill`. Pass `null` to restore. Mirrors
 *  `__resetGenerateTemplateForTests` so executor-driven tests never fire a real
 *  OpenRouter call. */
export function __resetDistillForTests(override: DistillFn | null): void {
  _distillOverride = override;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export const distill: DistillFn = (text, signal, prefill, trace) => {
  if (_distillOverride) return _distillOverride(text, signal, prefill, trace);
  return _distill(text, signal, prefill, trace);
};

async function _distill(
  text: string,
  signal: AbortSignal | undefined,
  prefill: GenerationPrefill | null | undefined,
  trace: TraceContext | undefined,
): Promise<DistillResult> {
  if (!DISTILL_PROMPT) {
    throw new Error("Distill prompt unavailable (data/distill-prompt.txt)");
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("BUILDER_OPENROUTER_API_KEY not configured");
  }

  const userContent =
    `Design an agent for this group based on the following request:\n\n` +
    `---\n${text}\n---` +
    buildPinnedIdentityNote(prefill);

  // `any` body so the OpenRouter extensions (per-block cache_control, the
  // json_schema with min/maxItems) pass through the OpenAI SDK unchanged —
  // mirrors the main generate call in templateGen.
  const body: any = {
    model: getModel(),
    messages: [
      // Per-block cache breakpoint on the static distill prompt (same rationale
      // as the generate call): byte-identical across generations, so caching its
      // prefix trims cost + latency without forcing Anthropic-only routing.
      {
        role: "system",
        content: [
          {
            type: "text",
            text: DISTILL_PROMPT,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "user", content: userContent },
    ],
    temperature: 0.7,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "agent_distill",
        strict: true,
        schema: {
          type: "object",
          properties: {
            agentName: { type: "string" },
            emoji: { type: "string" },
            description: { type: "string" },
            progressPhrases: {
              type: "array",
              items: { type: "string" },
              minItems: 6,
              maxItems: MAX_PHRASES,
            },
          },
          required: ["agentName", "emoji", "description", "progressPhrases"],
          additionalProperties: false,
        },
      },
    },
  };

  const data: any = await openRouterChatCompletion({
    apiKey,
    stage: "distill",
    body,
    signal,
    timeoutMs: DISTILL_TIMEOUT_MS,
    trace,
  });

  if (data?.error) {
    throw new Error(`Distill LLM error: ${data.error.message || "unknown"}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("No content in distill response");
  }
  return parseDistillResponse(content);
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

/** When the caller pinned part of the identity, tell the model to keep those
 *  exact values and fit the rest (phrases, description) around them. The
 *  executor still does the authoritative caller-wins merge; this just keeps the
 *  generated phrases coherent with a pinned name. */
function buildPinnedIdentityNote(prefill?: GenerationPrefill | null): string {
  if (!prefill) return "";
  const parts: string[] = [];
  const name = prefill.agentName?.trim();
  const emoji = prefill.emoji?.trim();
  const description = prefill.description?.trim();
  if (name) parts.push(`name "${name}"`);
  if (emoji) parts.push(`emoji "${emoji}"`);
  if (description) parts.push(`description "${description}"`);
  if (parts.length === 0) return "";
  return (
    `\n\nThe group already chose this agent's ${parts.join(", ")}. ` +
    `Return those exact values and write the remaining fields and the ` +
    `progressPhrases to fit them.`
  );
}

/** Parse + validate the distill LLM response. Exported for testing. */
export function parseDistillResponse(content: string): DistillResult {
  let parsed: any;
  try {
    const cleaned = content
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = content.match(/\{[\s\S]*"progressPhrases"[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `Failed to parse distill response as JSON: ${content.slice(0, 200)}`,
      );
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Failed to parse extracted distill JSON: ${match[0].slice(0, 200)}`,
      );
    }
  }

  const agentName =
    typeof parsed.agentName === "string"
      ? decodeEmojiEscapes(parsed.agentName).trim()
      : "";
  if (!agentName) {
    throw new Error("Distill response missing agentName");
  }

  const progressPhrases: string[] = Array.isArray(parsed.progressPhrases)
    ? parsed.progressPhrases
        .filter(
          (p: unknown): p is string =>
            typeof p === "string" && p.trim().length > 0,
        )
        .map((p: string) => decodeEmojiEscapes(p).trim())
        .slice(0, MAX_PHRASES)
    : [];
  if (progressPhrases.length < MIN_PHRASES) {
    throw new Error(
      `Distill response had too few progressPhrases (${progressPhrases.length})`,
    );
  }

  return {
    agentName,
    emoji: sanitizeEmojiField(
      typeof parsed.emoji === "string" ? parsed.emoji : "",
    ),
    description:
      typeof parsed.description === "string"
        ? decodeEmojiEscapes(parsed.description).trim()
        : "",
    progressPhrases,
  };
}
