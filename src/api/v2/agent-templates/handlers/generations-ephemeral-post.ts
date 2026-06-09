/**
 * Handler for POST /api/v2/agent-templates/generations/ephemeral
 *
 * NON-persisting generation. Runs the real generator and hands back the
 * produced template inline — it never writes an AgentTemplate or an
 * AgentTemplateGeneration row. Built for the admin compare tool, which
 * generates throwaway candidates (varying the builderPrompt and/or builderModel
 * override) purely to judge prompt quality across one or more ideas; nothing
 * should land in the catalog until an admin explicitly keeps one (via the
 * normal create endpoint).
 *
 * Response modes (content-negotiated, mirroring the async endpoint):
 *   - SSE (Accept: text/event-stream): emits a keep-alive every 15s while the
 *     generation runs, then closes with `event: result` carrying
 *     { template, metrics } or `event: error` on timeout/failure. HTTP status
 *     is always 200 in SSE mode. This is the path that honours the
 *     "never hold an idle connection" contract — a generation can run close to
 *     the 90s ceiling, well past where an intermediary would drop a silent
 *     connection.
 *   - JSON (default): holds the connection and returns { template, metrics }
 *     (200), 504 on timeout, or 500 on failure. Simpler, but with no heartbeat
 *     a long generation risks an intermediary timeout, so SSE is preferred for
 *     anything but the fastest calls.
 *
 * Admin-only: gated to agent-API-key callers (isApiKeyListener), like the
 * privileged builderPrompt/builderModel fields on the async endpoint. Because
 * the whole endpoint already requires an agent API key, those overrides need no
 * extra per-field auth gate here. Skips the async job machinery (idempotency,
 * status row, TTL) and content moderation — the caller is trusted and nothing
 * generated here is persisted or published.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import {
  startSseStream,
  writeSseEvent,
} from "@/api/v2/agent-templates/lib/sse";
import { isKnownOpenRouterModel } from "@/api/v2/agent-templates/services/openrouter-models";
import {
  callGenerateTemplate,
  type GenerateTemplateInput,
  type GenerationPrefill,
  type GenerationResult,
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
// Model-override cap — OpenRouter model ids are short slugs; this just bounds
// an obviously-abusive value (matches the async endpoint's builderModel cap).
const MAX_BUILDER_MODEL_LEN = 256;

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
    builderModel: z.string().min(1).max(MAX_BUILDER_MODEL_LEN).optional(),
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

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Outcome of one ephemeral generation, classified once so the JSON and SSE
 *  response paths can render it without re-inspecting the error.
 *  `aborted` = the client disconnected mid-flight; there's no one to respond
 *  to, so callers bail without writing. */
type Outcome =
  | { kind: "ok"; result: GenerationResult }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error" };

async function runGeneration(
  log: Request["log"],
  args: {
    input: GenerateTemplateInput;
    /** Composed signal handed to the generator — aborts on timeout OR client
     *  disconnect, so the upstream OpenRouter call is cancelled either way. */
    signal: AbortSignal;
    /** The 90s ceiling alone, kept separate so a disconnect-driven abort isn't
     *  misclassified (and logged) as a timeout. */
    timeoutSignal: AbortSignal;
    prefill: GenerationPrefill | null;
    builderPrompt: string | null;
    builderModel: string | null;
  },
): Promise<Outcome> {
  try {
    const result = await callGenerateTemplate(
      args.input,
      args.signal,
      args.prefill,
      undefined,
      args.builderPrompt,
      args.builderModel,
    );
    return { kind: "ok", result };
  } catch (err) {
    // The 90s ceiling is the only abort we surface as a timeout.
    if (args.timeoutSignal.aborted) {
      log.warn({ err }, "[ephemeral-generation] generation timed out");
      return { kind: "timeout" };
    }
    // Composed signal aborted but not the timeout → the client hung up. The
    // result is discarded anyway, so this is expected, not an error.
    if (args.signal.aborted) {
      log.info(
        "[ephemeral-generation] client disconnected; generation aborted",
      );
      return { kind: "aborted" };
    }
    // Keep the specifics in logs; callers surface a stable, generic message
    // (matches the other agent-templates handlers).
    log.error({ err }, "[ephemeral-generation] generation failed");
    return { kind: "error" };
  }
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
  const builderModel = parsed.data.builderModel ?? null;

  // Validate builderModel against OpenRouter's catalog so an unknown id fails
  // fast here instead of surfacing as a generic upstream error mid-generation.
  // Best-effort: the lookup fails open if the catalog is unreachable.
  if (builderModel && !(await isKnownOpenRouterModel(builderModel))) {
    res.status(400).json({
      error: `builderModel '${builderModel}' is not a valid OpenRouter model`,
    });
    return;
  }

  // Abort the upstream generation on the 90s ceiling OR a client disconnect.
  // Unlike the async endpoint (whose executor runs to completion to persist a
  // result), an ephemeral result is discarded the moment the client hangs up,
  // so finishing it would just burn model capacity. The timeout signal is kept
  // separate so a disconnect isn't misclassified as a timeout.
  const timeoutSignal = AbortSignal.timeout(getTimeoutMs());
  const abort = new AbortController();
  timeoutSignal.addEventListener(
    "abort",
    () => {
      abort.abort();
    },
    { once: true },
  );
  res.on("close", () => {
    abort.abort();
  });

  const generationArgs = {
    input: coalesced,
    signal: abort.signal,
    timeoutSignal,
    prefill,
    builderPrompt,
    builderModel,
  };

  // SSE mode: heartbeat while the generation runs, then a single terminal
  // frame. Mirrors the async endpoint's contract so a long generation never
  // holds a silent connection.
  if ((req.headers.accept || "").includes("text/event-stream")) {
    const keepalive = startSseStream(res);
    const outcome = await runGeneration(req.log, generationArgs);
    clearInterval(keepalive);

    // Client hung up mid-generation — its result was discarded and the stream
    // is gone, so there's nothing to write.
    if (outcome.kind === "aborted" || res.writableEnded || res.destroyed)
      return;

    // The client can still drop between the check above and the write below;
    // a write on a closed socket throws, so swallow it (nobody's listening).
    try {
      if (outcome.kind === "ok") {
        writeSseEvent(res, "result", {
          template: outcome.result.template,
          metrics: outcome.result.metrics,
        });
      } else if (outcome.kind === "timeout") {
        writeSseEvent(res, "error", { error: "Generation timed out" });
      } else {
        writeSseEvent(res, "error", { error: "Generation failed" });
      }
    } catch {
      // Client disconnected mid-write — swallow.
    }
    return;
  }

  // JSON mode: hold the connection and return the template inline.
  const outcome = await runGeneration(req.log, generationArgs);
  if (outcome.kind === "aborted" || res.writableEnded || res.destroyed) return;
  if (outcome.kind === "ok") {
    res.status(200).json({
      template: outcome.result.template,
      metrics: outcome.result.metrics,
    });
    return;
  }
  if (outcome.kind === "timeout") {
    res.status(504).json({ error: "Generation timed out" });
    return;
  }
  res.status(500).json({ error: "Generation failed" });
}
