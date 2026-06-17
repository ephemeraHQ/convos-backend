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
  type ResolvedAttachment,
} from "./templateGen";

// Loaded once at module init (same convention as the generator's SYSTEM_PROMPT).
// Null when the file can't be read — the executor treats that like any other
// distill failure and proceeds without phrases.
const DISTILL_PROMPT = loadDataPrompt("distill-prompt.txt");

// Distill is small (identity + ~6 short lines) so it caps far below the 120s
// main generate call — a hung distill must not eat the pipeline's time budget.
const DISTILL_TIMEOUT_MS = 60_000;

// The prompt asks for 6–8 phrases; accept down to this floor after filtering
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

/** What to distill an identity from. At least one of `text` / `attachments`
 *  must be present. */
export interface DistillInput {
  /** The user's text directive, including any voice transcripts the executor
   *  folded in. Optional — an image/PDF-only build distills from the files. */
  text?: string;
  /** Resolved image/PDF blocks. Sent to the vision-capable builder model so a
   *  bare image/PDF build still yields an identity card. Audio never reaches
   *  here — it's transcribed into `text` upstream. */
  attachments?: ResolvedAttachment[];
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
  input: DistillInput,
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

export const distill: DistillFn = (input, signal, prefill, trace) => {
  if (_distillOverride) return _distillOverride(input, signal, prefill, trace);
  return _distill(input, signal, prefill, trace);
};

async function _distill(
  input: DistillInput,
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

  const text = input.text?.trim();
  const attachments = input.attachments ?? [];
  if (!text && attachments.length === 0) {
    throw new Error("Distill called with neither text nor attachments");
  }

  const userContent = buildDistillUserContent(text, attachments, prefill);

  // `any` body so the OpenRouter extension (the per-block cache_control on the
  // system prompt) passes through the OpenAI SDK unchanged — mirrors the main
  // generate call in templateGen.
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
              // No minItems/maxItems: Anthropic's structured outputs reject any
              // array minItems other than 0 or 1. The prompt asks for 6–8 and
              // parseDistillResponse enforces the 4–8 bounds after the fact.
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

/** Build the distill user message: a plain string for a text-only build, or a
 *  multimodal block array (a directive + the image/PDF blocks) for a build that
 *  carries attachments, so the vision-capable builder model can distill an
 *  identity from a bare image/PDF. Mirrors the block layout the generate stage
 *  uses (`image_url` for images, native `file` blocks for PDFs). */
function buildDistillUserContent(
  text: string | undefined,
  attachments: ResolvedAttachment[],
  prefill: GenerationPrefill | null | undefined,
): string | any[] {
  const pinned = buildPinnedIdentityNote(prefill);

  if (attachments.length === 0) {
    return (
      `Design an agent for this group based on the following request:\n\n` +
      `---\n${text ?? ""}\n---` +
      pinned
    );
  }

  const intro = text
    ? `Design an agent for this group based on the following request and the ` +
      `attached files:\n\n---\n${text}\n---`
    : `Design an agent for this group based on the attached ` +
      `${describeDistillFiles(attachments)}. Infer the agent's purpose and ` +
      `personality from them.`;

  return [
    { type: "text", text: `${intro}${pinned}` },
    // Preserve the caller's mixed image/PDF order in the content blocks.
    ...attachments.map((attachment) =>
      attachment.kind === "image"
        ? { type: "image_url", image_url: { url: attachment.dataUri } }
        : {
            type: "file",
            file: {
              filename: attachment.filename,
              file_data: attachment.dataUri,
            },
          },
    ),
  ];
}

/** Short noun phrase for the attached files, for the image/PDF-only directive. */
function describeDistillFiles(attachments: ResolvedAttachment[]): string {
  const images = attachments.filter((a) => a.kind === "image").length;
  const pdfs = attachments.filter((a) => a.kind === "pdf").length;
  const noun = (n: number, singular: string) =>
    `${n} ${singular}${n === 1 ? "" : "s"}`;
  if (images > 0 && pdfs > 0) {
    return `files (${noun(images, "image")} and ${noun(pdfs, "document")})`;
  }
  if (pdfs > 0) return noun(pdfs, "document");
  return noun(images, "image");
}

/** When the caller pinned part of the identity, tell the model to keep those
 *  exact values and fit the rest (phrases, description) around them. The
 *  executor still does the authoritative caller-wins merge; this just keeps the
 *  generated phrases coherent with a pinned name. */
export function buildPinnedIdentityNote(
  prefill?: GenerationPrefill | null,
): string {
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
