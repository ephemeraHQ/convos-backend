/**
 * Handler for POST /api/v2/agent-templates/generations/ephemeral
 *
 * Synchronous, NON-persisting generation. Runs the real generator and returns
 * the produced template inline — it never writes an AgentTemplate or an
 * AgentTemplateGeneration row. Built for the admin compare tool, which generates
 * throwaway candidates (with and without a builderPrompt override) purely to
 * judge prompt quality across one or more ideas; nothing should land in the
 * catalog until an admin explicitly keeps one (via the normal create endpoint).
 *
 * Admin-only: gated to agent-API-key callers (isApiKeyListener), like the
 * privileged builderPrompt field on the async endpoint. Skips the async job
 * machinery (idempotency, status row, TTL) and content moderation — the caller
 * is trusted and nothing generated here is persisted or published.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import {
  callGenerateTemplate,
  type GenerateTemplateInput,
  type GenerationPrefill,
} from "@/api/v2/agent-templates/services/templateGen";

// One synchronous generation, kept under typical edge/proxy request ceilings.
const EPHEMERAL_TIMEOUT_MS = 90_000;

// Test seam: shrink the timeout so the 504 path is exercisable without waiting.
let _timeoutMsOverride: number | null = null;
export function __setEphemeralTimeoutMsForTests(ms: number | null): void {
  _timeoutMsOverride = ms;
}
function getTimeoutMs(): number {
  return _timeoutMsOverride ?? EPHEMERAL_TIMEOUT_MS;
}

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;
const MAX_BUILDER_PROMPT_LEN = 100_000;

const inputsSchema = z
  .object({
    text: z.string().optional(),
    idea: z.string().optional(),
    content: z.string().optional(),
    url: z.string().optional(),
    pdfBase64: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    imageBase64: z.string().optional(),
  })
  .strict();

const prefillSchema = z
  .object({
    agentName: z.string().trim().min(1).max(256).optional(),
    emoji: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    inputs: inputsSchema,
    builderPrompt: z.string().min(1).max(MAX_BUILDER_PROMPT_LEN).optional(),
    prefill: prefillSchema.optional(),
  })
  .strict();

// Mirror the async endpoint's coalescing: pick the first non-whitespace
// text-bearing field, and let a file (pdf/image) define the input type.
function coalesce(
  inputs: z.infer<typeof inputsSchema>,
): GenerateTemplateInput | null {
  const text = [inputs.text, inputs.idea, inputs.content, inputs.url].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (inputs.pdfBase64) {
    return {
      pdfBase64: inputs.pdfBase64,
      mimeType: inputs.mimeType || "application/pdf",
      filename: inputs.filename || "document.pdf",
      ...(text ? { text } : {}),
    };
  }
  if (inputs.imageBase64) {
    return {
      imageBase64: inputs.imageBase64,
      mimeType: inputs.mimeType || "image/png",
      ...(text ? { text } : {}),
    };
  }
  if (text) return { text };
  return null;
}

export async function generationsEphemeralPostHandler(
  req: Request,
  res: Response,
) {
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;
  if (!isApiKeyListener) {
    res
      .status(403)
      .json({ error: "ephemeral generation requires agent API key auth" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const coalesced = coalesce(parsed.data.inputs);
  if (!coalesced) {
    res.status(400).json({
      error:
        "No usable input — provide one of text, idea, content, url, pdfBase64, or imageBase64",
    });
    return;
  }
  if (coalesced.text && coalesced.text.length > MAX_TEXT_LEN) {
    res.status(400).json({ error: `text exceeds ${MAX_TEXT_LEN} characters` });
    return;
  }
  if (
    (coalesced.pdfBase64 && coalesced.pdfBase64.length > MAX_BASE64_LEN) ||
    (coalesced.imageBase64 && coalesced.imageBase64.length > MAX_BASE64_LEN)
  ) {
    res.status(400).json({ error: "attached file exceeds the size limit" });
    return;
  }

  const prefill: GenerationPrefill | null = parsed.data.prefill ?? null;
  const builderPrompt = parsed.data.builderPrompt ?? null;

  // Held in a variable so the catch can distinguish a timeout (signal.aborted)
  // from a generation error without parsing the wrapped error message.
  const signal = AbortSignal.timeout(getTimeoutMs());
  try {
    const { template, metrics } = await callGenerateTemplate(
      coalesced,
      signal,
      prefill,
      undefined,
      builderPrompt,
    );
    res.status(200).json({ template, metrics });
    return;
  } catch (err) {
    if (signal.aborted) {
      req.log.warn({ err }, "[ephemeral-generation] generation timed out");
      res.status(504).json({ error: "Generation timed out" });
      return;
    }
    // Keep the specifics in logs; return a stable, generic message to the
    // client (matches the other agent-templates handlers).
    req.log.error({ err }, "[ephemeral-generation] generation failed");
    res.status(500).json({ error: "Generation failed" });
    return;
  }
}
