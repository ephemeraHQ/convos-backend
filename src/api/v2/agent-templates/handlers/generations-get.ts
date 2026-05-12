/**
 * Handler for GET /api/v2/agent-templates/generations/:generationId
 *
 * Returns the current status of a generation. Optionally long-polls until
 * terminal via `?wait_ms=N` (capped at 45_000, polled every 500 ms).
 *
 * Visibility:
 *   - Cross-account access returns 404 (don't leak existence).
 *   - Expired rows (expiresAt < NOW()) return 404.
 *
 * Response shape:
 *   {
 *     generationId, status,
 *     templateId?, error?,
 *     createdAt, updatedAt
 *   }
 *
 * Auth: authOrAgentApiKeyAuth + requireAccount.
 * Production guard: XMTP_ENV !== "production" (in v2/index.ts).
 *
 * (PR #201 will extend the response with an optional `reply` field for
 * twitterContext-bearing generations.)
 */

import type { Request, Response } from "express";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WAIT_MS = 45_000;
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GenerationRow {
  id: string;
  status: string;
  templateId: string | null;
  error: string | null;
  expiresAt: Date | null;
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
  if (row.templateId) out.templateId = row.templateId;
  if (row.error) out.error = row.error;
  return out;
}

async function fetchOwnedRow(
  generationId: string,
  ownerAccountId: string,
): Promise<GenerationRow | null> {
  return prisma.agentTemplateGeneration.findFirst({
    where: { id: generationId, ownerAccountId },
    select: {
      id: true,
      status: true,
      templateId: true,
      error: true,
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

async function waitForTerminal(
  generationId: string,
  ownerAccountId: string,
  waitMs: number,
): Promise<GenerationRow | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const row = await fetchOwnedRow(generationId, ownerAccountId);
    if (!row) return null;
    if (isExpired(row)) return null;
    if (isTerminal(row.status)) return row;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }
  // Timeout — return current state, hide already-expired rows
  const final = await fetchOwnedRow(generationId, ownerAccountId);
  if (final && isExpired(final)) return null;
  return final;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generationsGetHandler(req: Request, res: Response) {
  const { generationId } = req.params;

  // 1. Validate wait_ms
  const waitMs = parseWaitMs(req.query.wait_ms);
  if (waitMs === -1) {
    res
      .status(400)
      .json({ error: "wait_ms must be a non-negative integer" });
    return;
  }

  // 2. Auth → ownerAccountId
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // 3. Fetch (with optional long-poll)
  let row: GenerationRow | null;
  if (waitMs > 0) {
    row = await waitForTerminal(generationId, ownerAccountId, waitMs);
  } else {
    row = await fetchOwnedRow(generationId, ownerAccountId);
    if (row && isExpired(row)) row = null;
  }

  // 4. Not found / expired / cross-account → 404
  if (!row) {
    res.status(404).json({ error: "Generation not found" });
    return;
  }

  res.status(200).json(toResponse(row));
}
