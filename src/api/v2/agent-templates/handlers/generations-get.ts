/**
 * Handler for GET /api/v2/agent-templates/generations/:generationId
 *
 * Returns the current status of a generation. Optionally long-polls until
 * terminal via `?wait_ms=N` (capped at 45_000, polled every 500 ms).
 *
 * HTTP status is the in-progress/terminal signal:
 *   - 202 while `pending`/`running` — body carries `progressPhrases`, the
 *     `preview` (the draft agent's identity: agentName/emoji/description) as
 *     they fill in, and `estimatedDurationMs` (a rough build-time estimate the
 *     client can size a progress indicator against).
 *   - 200 once `done`/`failed` — `preview`/`progressPhrases`/`estimatedDurationMs`
 *     drop off; the body carries `templateId` (the client fetches the real
 *     template for the full fields) or `error`.
 *
 * Visibility:
 *   - The generation ID itself is the capability — anyone with the UUID
 *     can read the row. (Anonymous submissions need this; once they have
 *     the ID handed back from POST, no auth is required to poll status.)
 *   - Expired rows (expiresAt < NOW()) return 404.
 *
 * Response shape:
 *   {
 *     generationId, status,
 *     templateId?, error?, preview?, progressPhrases?, estimatedDurationMs?,
 *     createdAt, updatedAt
 *   }
 *
 * Auth: optionalAuthOrAgentApiKeyAuth. Anonymous reads are permitted; the
 * generation ID is treated as a bearer secret.
 */

import type { Request, Response } from "express";
import {
  estimatedDurationMs,
  previewResponseFields,
  type AgentPreview,
} from "@/api/v2/agent-templates/lib/generation-preview";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WAIT_MS = 45_000;

/**
 * Adaptive backoff for the long-poll loop.
 *
 * Most generations complete in 10–30s. Fast early polls catch them with
 * near-instant terminal detection; later polls back off so a hung 45s
 * long-poll doesn't fire 90 DB queries.
 *
 * Per-request DB queries for a typical 30s generation drop from ~60
 * (constant 500ms) to ~25.
 *
 * TODO(scale): When concurrent long-poll volume justifies it, replace
 * polling entirely with Postgres LISTEN/NOTIFY. The executor would
 * `pg_notify('generation_complete', generationId)` after each terminal
 * write; long-poll handlers would `LISTEN` via a dedicated `pg` client
 * (outside the Prisma pool) and await the notification with this
 * timeout as the fallback. ~150 LOC; defer until polling load is real.
 */
function nextPollIntervalMs(attempt: number): number {
  if (attempt < 2) return 100;
  if (attempt < 4) return 250;
  if (attempt < 8) return 500;
  if (attempt < 16) return 1000;
  return 2000;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GenerationRow {
  id: string;
  status: string;
  templateId: string | null;
  reply: string | null;
  error: string | null;
  preview: unknown;
  progressPhrases: unknown;
  inputs: unknown;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GenerationResponse {
  generationId: string;
  status: string;
  templateId?: string;
  reply?: { text: string };
  error?: string;
  preview?: AgentPreview;
  progressPhrases?: string[];
  estimatedDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

const isTerminal = (status: string): boolean =>
  status === "done" || status === "failed";

const isExpired = (row: GenerationRow): boolean =>
  row.expiresAt !== null && row.expiresAt < new Date();

function toResponse(row: GenerationRow): GenerationResponse {
  const out: GenerationResponse = {
    generationId: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // `preview` (the draft agent), `progressPhrases`, and the build-duration
  // estimate ride only the in-progress 202s; the terminal 200 hands back
  // `templateId` (the client fetches the real template) / `error` instead.
  if (!isTerminal(row.status)) {
    Object.assign(out, previewResponseFields(row.preview, row.progressPhrases));
    out.estimatedDurationMs = estimatedDurationMs(row.inputs);
  }
  if (row.templateId) out.templateId = row.templateId;
  if (row.reply) out.reply = { text: row.reply };
  if (row.error) out.error = row.error;
  return out;
}

async function fetchRow(generationId: string): Promise<GenerationRow | null> {
  return prisma.agentTemplateGeneration.findUnique({
    where: { id: generationId },
    select: {
      id: true,
      status: true,
      templateId: true,
      reply: true,
      error: true,
      preview: true,
      progressPhrases: true,
      inputs: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

function parseWaitMs(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "string") return 0;
  if (!/^\d+$/.test(raw)) return -1; // sentinel: invalid
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_WAIT_MS);
}

async function waitForTerminal(args: {
  generationId: string;
  waitMs: number;
  /** Returns true once the client has hung up the request. The loop bails
   *  early in that case to avoid wasted DB queries when nobody is listening. */
  isClosed: () => boolean;
}): Promise<GenerationRow | null> {
  const deadline = Date.now() + args.waitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (args.isClosed()) return null;
    const row = await fetchRow(args.generationId);
    if (!row) return null;
    if (isExpired(row)) return null;
    if (isTerminal(row.status)) return row;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(nextPollIntervalMs(attempt), remaining)),
    );
    attempt += 1;
  }
  // Timeout — return current state, hide already-expired rows
  if (args.isClosed()) return null;
  const final = await fetchRow(args.generationId);
  if (final && isExpired(final)) return null;
  return final;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generationsGetHandler(
  req: Request<{ generationId: string }>,
  res: Response,
) {
  const { generationId } = req.params;

  // Track client disconnect so long-poll can bail early.
  // Use res.on("close") not req.on("close"): IncomingMessage's "close" fires
  // when the request body is fully consumed, whereas ServerResponse's fires
  // only when the underlying connection terminates — which is what
  // "client disconnected" actually means here.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  // 1. Validate wait_ms
  const waitMs = parseWaitMs(req.query.wait_ms);
  if (waitMs === -1) {
    res.status(400).json({ error: "wait_ms must be a non-negative integer" });
    return;
  }

  // 2. Fetch (with optional long-poll). No ownership check — the
  //    generation ID is the capability.
  let row: GenerationRow | null;
  if (waitMs > 0) {
    row = await waitForTerminal({
      generationId,
      waitMs,
      isClosed: () => closed,
    });
  } else {
    row = await fetchRow(generationId);
    if (row && isExpired(row)) row = null;
  }

  // If the client hung up mid-poll, don't bother writing a response —
  // express will already have torn down the socket. (TS flow analysis can't
  // see the close-listener mutation, so suppress no-unnecessary-condition.)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (closed || res.writableEnded) return;

  // 3. Not found / expired → 404
  if (!row) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }

  // The HTTP status IS the in-progress/terminal signal: 202 while
  // pending/running (body carries progressPhrases + preview), 200 once
  // done/failed (body carries templateId, or the error).
  res.status(isTerminal(row.status) ? 200 : 202).json(toResponse(row));
}
