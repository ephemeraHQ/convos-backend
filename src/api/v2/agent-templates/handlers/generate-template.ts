/**
 * Handler for POST /api/v2/agent-templates/generate (JSON + SSE modes).
 *
 * Auth via `authOrAgentApiKeyAuth` + `requireAccount`. Validation runs BEFORE
 * any branch on `Accept` so bad inputs always return JSON 400. Legacy field
 * coalescing accepts `text|idea|content|url`. Body limits: MAX_TEXT_LEN=50_000,
 * MAX_BASE64_LEN=35_000_000.
 *
 * On success, the generated template is persisted as a draft AgentTemplate
 * with `ownerAccountId` from `getEffectiveOwnerId(res)`, then returned in
 * serialized form (including id, slug, ownerAccountId, etc.).
 *
 * Accept header routing:
 *   - Contains `text/event-stream` substring → SSE mode
 *   - Otherwise (default) → JSON mode
 *
 * SSE mode:
 *   - Headers: Content-Type: text/event-stream, Cache-Control: no-cache,
 *     Connection: keep-alive; flushHeaders() called before any data.
 *   - Keep-alive: `:\n\n` comment every 15 000 ms while pending.
 *   - Success: `event: result\ndata: <serialized template JSON>\n\n`, then res.end().
 *   - Error:   `event: error\ndata: {"error":"...","status":<int>}\n\n`, then res.end().
 *   - HTTP status line is always 200 (headers flushed before terminal frame).
 *   - Client disconnect: generateTemplate NOT aborted (no AbortSignal);
 *     keep-alive write errors swallowed; clearInterval always runs.
 *
 * PostHog metering:
 *   - On every invocation that reaches the LLM call (success OR error),
 *     a `builder.template.generated` event is captured fire-and-forget.
 *   - Properties: model, promptTokens, completionTokens, latencyMs,
 *     requestId (UUID v4), authMode ("jwt" | "agentKey"), ownerAccountId.
 *   - Validation errors that 400 BEFORE the LLM call emit ZERO events.
 *   - Missing POSTHOG_API_KEY/POSTHOG_HOST → silent no-op.
 *
 * Error → status mapping (both modes):
 *   - Validation-class messages (Invalid URL|No content|Could not extract) → 400
 *   - Upstream timeout messages (OpenRouter request timed out) → 504
 *   - All other rejections → 502
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import { capturePostHog } from "@/api/v2/agent-templates/services/posthog";
import {
  callGenerateTemplate,
  getModel,
} from "@/api/v2/agent-templates/services/templateGen";
import { AGENT_API_KEY_HEADER } from "@/middleware/agentAuth";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";
import { buildSlug } from "@/utils/slug-hash";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;

/** Regex matching validation-class error messages that should map to 400.
 *  "No content extracted" is a URL-extraction validation error → 400.
 *  "No content in LLM response" is an LLM failure → 502 (not matched here).
 */
const VALIDATION_ERROR_RE =
  /^(Invalid URL|No content extracted|Could not extract)/i;

/** Regex matching upstream-timeout error messages that should map to 504. */
const TIMEOUT_ERROR_RE = /^OpenRouter request timed out/i;

// ---------------------------------------------------------------------------
// Template persistence
// ---------------------------------------------------------------------------

/** Derive a slug-safe base from an agent name. */
const deriveBaseSlug = (agentName: string): string =>
  agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Persist a generated template as a draft AgentTemplate.
 *
 *  The `id` is generated client-side via `randomUUID()` so the stable slug
 *  hash can be computed before the INSERT — single write, no follow-up UPDATE.
 */
const persistDraftTemplate = async (
  template: {
    agentName: string;
    description: string;
    prompt: string;
    category: string;
    emoji: string;
    tools: string[];
    connections: string[];
  },
  ownerAccountId: string,
) => {
  const baseSlug = deriveBaseSlug(template.agentName);
  const id = randomUUID();
  const slug = buildSlug(baseSlug, id);

  return prisma.agentTemplate.create({
    data: {
      id,
      slug,
      ownerAccountId,
      forkedFromId: null,
      agentName: template.agentName,
      description: template.description || null,
      prompt: template.prompt,
      category: template.category || null,
      emoji: template.emoji || null,
      avatarUrl: null,
      tools: template.tools,
      connections: template.connections,
      version: 1,
      firstPublishedAt: null,
      status: "draft",
      featured: false,
    },
  });
};

// ---------------------------------------------------------------------------
// Test seam for persistDraftTemplate
// ---------------------------------------------------------------------------

/** Shape returned by the persist test seam — subset that serializeAgentTemplate needs. */
export interface PersistedTemplateForTests {
  id: string;
  slug: string;
  ownerAccountId: string;
  forkedFromId: string | null;
  agentName: string;
  description: string | null;
  prompt: string;
  category: string | null;
  emoji: string | null;
  avatarUrl: string | null;
  tools: string[];
  connections: string[];
  version: number;
  firstPublishedAt: Date | null;
  status: string;
  featured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let _persistOverride:
  | ((
      template: Parameters<typeof persistDraftTemplate>[0],
      ownerAccountId: string,
    ) => Promise<PersistedTemplateForTests>)
  | null = null;

/**
 * Install a test override for the template persistence step.
 * Pass `null` to restore normal behaviour (uses prisma).
 *
 * The override receives the generated template + ownerAccountId
 * and must return an object matching PersistedTemplateForTests.
 */
export function __resetPersistForTests(
  override: typeof _persistOverride,
): void {
  _persistOverride = override;
}

/** Internal: delegates to override if installed, otherwise prisma. */
const doPersist = (
  template: Parameters<typeof persistDraftTemplate>[0],
  ownerAccountId: string,
) =>
  _persistOverride
    ? _persistOverride(template, ownerAccountId)
    : persistDraftTemplate(template, ownerAccountId);

// ---------------------------------------------------------------------------
// Zod schema — validates & coalesces the request body
// ---------------------------------------------------------------------------

const generateBodySchema = z
  .object({
    /** Primary text input. */
    text: z.string().optional(),
    /** Legacy alias for text. */
    idea: z.string().optional(),
    /** Legacy alias for text. */
    content: z.string().optional(),
    /** Legacy alias for text. */
    url: z.string().optional(),
    /** Base64-encoded PDF content. */
    pdfBase64: z.string().optional(),
    /** MIME type for PDF/image inputs. */
    mimeType: z.string().optional(),
    /** Filename for PDF inputs. */
    filename: z.string().optional(),
    /** Base64-encoded image content. */
    imageBase64: z.string().optional(),
  })
  .strict();

type GenerateBody = z.infer<typeof generateBodySchema>;

// ---------------------------------------------------------------------------
// Coalescing: first non-empty among text|idea|content|url wins
// ---------------------------------------------------------------------------

const coalesceText = (
  body: GenerateBody,
):
  | { text: string }
  | { pdfBase64: string; mimeType: string; filename: string }
  | { imageBase64: string; mimeType: string }
  | null => {
  // File inputs take priority when present
  if (body.pdfBase64) {
    return {
      pdfBase64: body.pdfBase64,
      mimeType: body.mimeType || "application/pdf",
      filename: body.filename || "document.pdf",
    };
  }

  if (body.imageBase64) {
    return {
      imageBase64: body.imageBase64,
      mimeType: body.mimeType || "image/png",
    };
  }

  // Text coalescing: first non-empty among text → idea → content → url
  const coalesced = body.text || body.idea || body.content || body.url;

  if (coalesced && coalesced.trim().length > 0) {
    return { text: coalesced };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Error → status mapping
// ---------------------------------------------------------------------------

const errorStatus = (error: Error): number => {
  if (VALIDATION_ERROR_RE.test(error.message)) return 400;
  if (TIMEOUT_ERROR_RE.test(error.message)) return 504;
  return 502;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generateTemplateHandler(req: Request, res: Response) {
  // 1. Validate body shape with zod
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const body = parsed.data;

  // 2. Coalesce input — determine what we're generating from
  const coalesced = coalesceText(body);

  if (!coalesced) {
    res.status(400).json({
      error:
        "One of text, idea, content, url, pdfBase64, or imageBase64 is required",
    });
    return;
  }

  // 3. Validate lengths BEFORE any Accept branch (so bad inputs always get JSON 400)
  if ("text" in coalesced && coalesced.text.length > MAX_TEXT_LEN) {
    res.status(400).json({
      error: `Text exceeds maximum length of ${MAX_TEXT_LEN} characters`,
    });
    return;
  }

  if ("pdfBase64" in coalesced && coalesced.pdfBase64.length > MAX_BASE64_LEN) {
    res.status(400).json({
      error: `PDF base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }

  if (
    "imageBase64" in coalesced &&
    coalesced.imageBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `Image base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }

  // --- Past this point, the request WILL reach the LLM call ---
  // Resolve the effective owner for template persistence.
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // Prepare PostHog metering data (capture fires on both success & error).
  const requestId = randomUUID();
  const startTime = performance.now();
  const authMode: "jwt" | "agentKey" = req.header(AGENT_API_KEY_HEADER)
    ? "agentKey"
    : "jwt";

  /** Fire PostHog capture — always fire-and-forget (non-blocking). */
  const meter = (metrics: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }) => {
    capturePostHog({ ...metrics, requestId, authMode, ownerAccountId });
  };

  // 4. Branch on Accept header — SSE vs JSON mode
  const accept = req.headers.accept || "";
  const isSSE = accept.includes("text/event-stream");

  if (isSSE) {
    // ---- SSE mode ----
    // Set SSE headers and flush immediately so the client knows the stream is live
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // No X-Accel-Buffering header — preserve pool's absence
    res.flushHeaders();

    // Start keep-alive interval: emit `:\n\n` comment every 15 000 ms
    const KEEPALIVE_MS = 15_000;
    const keepalive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch {
        // Swallow write errors (client disconnected, stream ended, etc.)
        // No uncaughtException leak
      }
    }, KEEPALIVE_MS);

    try {
      const { template, metrics } = await callGenerateTemplate(coalesced);

      // Persist as draft with the authenticated account as owner
      const persisted = await doPersist(template, ownerAccountId);

      // PostHog: success — fire-and-forget
      meter(metrics);

      // Terminal success frame — return serialized persisted template
      clearInterval(keepalive);
      const data = JSON.stringify(
        serializeAgentTemplate(
          persisted as Parameters<typeof serializeAgentTemplate>[0],
        ),
      );
      res.write(`event: result\ndata: ${data}\n\n`);
      res.end();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      req.log.warn({ error: error.message }, "Template generation failed");

      // PostHog: error — fire-and-forget (token counts unavailable)
      meter({
        model: getModel(),
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Math.round(performance.now() - startTime),
      });

      // Terminal error frame — HTTP status is 200 (already flushed)
      clearInterval(keepalive);
      const status = errorStatus(error);
      const data = JSON.stringify({ error: error.message, status });
      res.write(`event: error\ndata: ${data}\n\n`);
      res.end();
    }

    return;
  }

  // ---- JSON mode (default) ----
  try {
    const { template, metrics } = await callGenerateTemplate(coalesced);

    // Persist as draft with the authenticated account as owner
    const persisted = await doPersist(template, ownerAccountId);

    // PostHog: success — fire-and-forget
    meter(metrics);

    res
      .status(200)
      .json(
        serializeAgentTemplate(
          persisted as Parameters<typeof serializeAgentTemplate>[0],
        ),
      );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    req.log.warn({ error: error.message }, "Template generation failed");

    // PostHog: error — fire-and-forget (token counts unavailable)
    meter({
      model: getModel(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Math.round(performance.now() - startTime),
    });

    const status = errorStatus(error);
    res.status(status).json({ error: error.message });
  }
}
