/**
 * Handler for POST /api/v2/agent-templates/generations
 *
 * Async builder endpoint. Creates an AgentTemplateGeneration row, runs
 * submit-time gates (idempotency, content moderation), fires the executor
 * fire-and-forget, and returns 202 { generationId } by default.
 *
 * Modes:
 *   - JSON (default): returns 202 { generationId } immediately. Caller polls
 *     GET /generations/{generationId} for terminal status.
 *   - JSON with ?wait_ms=N: long-polls inline up to N ms (capped at 45_000)
 *     and returns the terminal state if reached, otherwise the current state.
 *   - SSE (Accept: text/event-stream): emits keep-alive every 15s while the
 *     generation is non-terminal; terminal frame is `event: result` (done) or
 *     `event: error` (failed). HTTP status is always 200 in SSE mode.
 *
 * Submit-time validation order (each check returns and short-circuits):
 *   1. Body shape (zod)                                         → 400
 *   2. Content-Length > 40 MB                                   → 413
 *   3. Coalesced inputs present                                 → 400
 *   4. Input length limits (text ≤ 50k, base64 ≤ 35M)           → 400
 *   5. Auth + getEffectiveOwnerId                               → 403
 *   6. Idempotency-Key header present                           → 400
 *   7. Idempotency lookup → existing same body                  → 200/202
 *   8.                  → existing different body              → 409
 *   9. Content moderation (universal)                           → 422
 *  10. Persist row + fire executor + respond per mode
 *
 * Auth: authOrAgentApiKeyAuth + requireAccount.
 * Production guard: XMTP_ENV !== "production" (in v2/index.ts).
 * Body size: 40 MB (route-specific middleware).
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { executeGeneration } from "@/api/v2/agent-templates/services/generation-executor";
import { checkContent } from "@/api/v2/agent-templates/services/moderation";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_WAIT_MS = 45_000;
const POLL_INTERVAL_MS = 500;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

let _sseKeepaliveMsOverride: number | null = null;

/**
 * Override the SSE keep-alive interval for tests.
 * Pass `null` to restore the default 15 000 ms.
 */
export function __setSseKeepaliveMsForTests(ms: number | null): void {
  _sseKeepaliveMsOverride = ms;
}

function getSseKeepaliveMs(): number {
  return _sseKeepaliveMsOverride ?? DEFAULT_SSE_KEEPALIVE_MS;
}

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

/** Inputs to the template generator. Coalescing priority:
 *  pdfBase64 → imageBase64 → text → idea → content → url */
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

const bodySchema = z
  .object({
    source: z.string().min(1, "source is required"),
    inputs: inputsSchema,
  })
  .strict();

type Body = z.infer<typeof bodySchema>;
type Inputs = z.infer<typeof inputsSchema>;

// ---------------------------------------------------------------------------
// Coalescing — for length validation; also used in executor at runtime
// ---------------------------------------------------------------------------

type CoalescedInput =
  | { kind: "text"; text: string }
  | { kind: "pdfBase64"; pdfBase64: string }
  | { kind: "imageBase64"; imageBase64: string };

function coalesceInputs(inputs: Inputs): CoalescedInput | null {
  if (inputs.pdfBase64) return { kind: "pdfBase64", pdfBase64: inputs.pdfBase64 };
  if (inputs.imageBase64)
    return { kind: "imageBase64", imageBase64: inputs.imageBase64 };
  const text = inputs.text || inputs.idea || inputs.content || inputs.url;
  if (text && text.trim().length > 0) return { kind: "text", text };
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency body comparison — strict JSON equality after canonical sort
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function bodiesMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

// ---------------------------------------------------------------------------
// Wait_ms long-poll helper
// ---------------------------------------------------------------------------

const isTerminal = (status: string): boolean =>
  status === "done" || status === "failed";

async function waitForTerminal(
  generationId: string,
  ownerAccountId: string,
  waitMs: number,
): Promise<GenerationRow | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const row = await fetchOwnedGeneration(generationId, ownerAccountId);
    if (!row) return null;
    if (isTerminal(row.status)) return row;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }
  return fetchOwnedGeneration(generationId, ownerAccountId);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

interface GenerationRow {
  id: string;
  status: string;
  templateId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GenerationResponse {
  generationId: string;
  status: string;
  templateId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function toResponse(row: GenerationRow): GenerationResponse {
  const out: GenerationResponse = {
    generationId: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.templateId) out.templateId = row.templateId;
  if (row.error) out.error = row.error;
  return out;
}

async function fetchOwnedGeneration(
  generationId: string,
  ownerAccountId: string,
): Promise<GenerationRow | null> {
  const row = await prisma.agentTemplateGeneration.findFirst({
    where: { id: generationId, ownerAccountId },
    select: {
      id: true,
      status: true,
      templateId: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return row;
}

function parseWaitMs(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "string") return 0;
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_WAIT_MS);
}

// ---------------------------------------------------------------------------
// SSE mode helpers
// ---------------------------------------------------------------------------

function startSseStream(res: Response): ReturnType<typeof setInterval> {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const keepalive = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch {
      // Client gone — swallow
    }
  }, getSseKeepaliveMs());

  res.on("close", () => {
    clearInterval(keepalive);
  });

  return keepalive;
}

async function streamUntilTerminal(
  res: Response,
  keepalive: ReturnType<typeof setInterval>,
  generationId: string,
  ownerAccountId: string,
): Promise<void> {
  // Poll until terminal — no overall deadline; client can disconnect to cancel
  for (;;) {
    const row = await fetchOwnedGeneration(generationId, ownerAccountId);
    if (!row) {
      // Disappeared — emit error frame
      clearInterval(keepalive);
      const data = JSON.stringify({ error: "Generation not found" });
      res.write(`event: error\ndata: ${data}\n\n`);
      res.end();
      return;
    }
    if (isTerminal(row.status)) {
      clearInterval(keepalive);
      if (row.status === "done") {
        const data = JSON.stringify(toResponse(row));
        res.write(`event: result\ndata: ${data}\n\n`);
      } else {
        const data = JSON.stringify({
          error: row.error || "Generation failed",
          ...toResponse(row),
        });
        res.write(`event: error\ndata: ${data}\n\n`);
      }
      res.end();
      return;
    }
    if (res.writableEnded || res.destroyed) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generationsPostHandler(req: Request, res: Response) {
  // 1. Body size guard (Content-Length is best-effort; the route's body
  //    parser also enforces the limit at parse time)
  const contentLength = Number.parseInt(req.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }

  // 2. Body shape
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }
  const body: Body = parsed.data;

  // 3. Coalesced input present
  const coalesced = coalesceInputs(body.inputs);
  if (!coalesced) {
    res.status(400).json({
      error:
        "inputs must include one of text, idea, content, url, pdfBase64, or imageBase64",
    });
    return;
  }

  // 4. Length limits
  if (coalesced.kind === "text" && coalesced.text.length > MAX_TEXT_LEN) {
    res.status(400).json({
      error: `Text exceeds maximum length of ${MAX_TEXT_LEN} characters`,
    });
    return;
  }
  if (
    coalesced.kind === "pdfBase64" &&
    coalesced.pdfBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `PDF base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }
  if (
    coalesced.kind === "imageBase64" &&
    coalesced.imageBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `Image base64 exceeds maximum length of ${MAX_BASE64_LEN} characters`,
    });
    return;
  }

  // 5. Auth → ownerAccountId
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // 6. Idempotency-Key required
  const idempotencyKey = req.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length === 0) {
    res.status(400).json({ error: "Idempotency-Key header required" });
    return;
  }

  // 7+8. Idempotency dedupe lookup
  const existing = await prisma.agentTemplateGeneration.findUnique({
    where: {
      ownerAccountId_idempotencyKey: { ownerAccountId, idempotencyKey },
    },
    select: {
      id: true,
      inputs: true,
      status: true,
      templateId: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (existing) {
    if (!bodiesMatch(existing.inputs, body.inputs)) {
      res.status(409).json({
        error: "Idempotency-Key reused with different body",
      });
      return;
    }
    // Same key + same body → return existing row
    const httpStatus = isTerminal(existing.status) ? 200 : 202;
    res.status(httpStatus).json(toResponse(existing));
    return;
  }

  // 9. Content moderation gate (universal)
  const moderationInput =
    coalesced.kind === "text"
      ? coalesced.text
      : `[binary input: ${coalesced.kind}, ${coalesced.kind === "pdfBase64" ? coalesced.pdfBase64.length : coalesced.imageBase64.length} bytes]`;
  const moderation = await checkContent(moderationInput);
  if (!moderation.allowed) {
    res.status(422).json({
      reason: moderation.reason || "blocked",
      category: "content",
    });
    return;
  }

  // 10. Persist + fire executor
  let created;
  try {
    created = await prisma.agentTemplateGeneration.create({
      data: {
        ownerAccountId,
        source: body.source,
        idempotencyKey,
        inputs: body.inputs as object,
        status: "pending",
      },
      select: {
        id: true,
        status: true,
        templateId: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    // Race: another request created with the same key between our lookup
    // and insert. Re-fetch and treat as the dedupe path.
    const racedRow = await prisma.agentTemplateGeneration.findUnique({
      where: {
        ownerAccountId_idempotencyKey: { ownerAccountId, idempotencyKey },
      },
      select: {
        id: true,
        inputs: true,
        status: true,
        templateId: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (racedRow) {
      if (!bodiesMatch(racedRow.inputs, body.inputs)) {
        res.status(409).json({
          error: "Idempotency-Key reused with different body",
        });
        return;
      }
      const httpStatus = isTerminal(racedRow.status) ? 200 : 202;
      res.status(httpStatus).json(toResponse(racedRow));
      return;
    }
    req.log.error({ err }, "[generations-post] Insert failed");
    res.status(500).json({ error: "Failed to create generation" });
    return;
  }

  // Fire-and-forget — capture req.log so failure carries the requestId
  void executeGeneration(created.id).catch((err: unknown) => {
    req.log.error(
      { err, generationId: created.id },
      "[generations-post] Background executor failed",
    );
  });

  // 11. Response mode
  const accept = req.headers.accept || "";
  const isSSE = accept.includes("text/event-stream");

  if (isSSE) {
    const keepalive = startSseStream(res);
    await streamUntilTerminal(res, keepalive, created.id, ownerAccountId);
    return;
  }

  const waitMs = parseWaitMs(req.query.wait_ms);
  if (waitMs > 0) {
    const finalRow = await waitForTerminal(created.id, ownerAccountId, waitMs);
    if (!finalRow) {
      res.status(404).json({ error: "Generation not found" });
      return;
    }
    const httpStatus = isTerminal(finalRow.status) ? 200 : 202;
    res.status(httpStatus).json(toResponse(finalRow));
    return;
  }

  res.status(202).json(toResponse(created));
}
