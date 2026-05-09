/**
 * Handler for GET /api/v2/agent-templates/create-job/:jobId
 *
 * Returns the current status of a create-job.
 *
 * Long-polling: accepts `?wait_ms=N` query parameter.
 *   - Capped at 45,000ms
 *   - Polls every 500ms
 *   - Returns immediately when job reaches terminal state
 *   - Returns current status when timeout expires
 *
 * Expired jobs (expiresAt < NOW()) return 404.
 * Cross-account access returns 404 (not 403 — don't leak job existence).
 *
 * Twitter source done jobs: result includes { templateId, slug, templateUrl, replyText }
 *   - Does NOT include provisioningInstanceId, conversationId, inboxId
 *
 * App/web source done jobs: result includes { templateId, provisioningInstanceId, conversationId?, inboxId? }
 *   - Does NOT include slug, templateUrl, replyText
 *
 * Auth: authOrAgentApiKeyAuth
 * Production guard: XMTP_ENV !== "production" (in v2/index.ts)
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WAIT_MS = 45_000;
const POLL_INTERVAL_MS = 500;

const isTerminal = (status: string): boolean =>
  status === "done" || status === "failed";

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

const waitMsSchema = z
  .string()
  .transform((val) => parseInt(val, 10))
  .refine((val) => !isNaN(val), "wait_ms must be a number")
  .refine((val) => val >= 0, "wait_ms must be non-negative");

// ---------------------------------------------------------------------------
// Long-polling helper
// ---------------------------------------------------------------------------

async function waitForTerminalStatus(
  jobId: string,
  ownerAccountId: string,
  waitMs: number,
): Promise<{
  id: string;
  status: string;
  source: string;
  result: string | null;
  error: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const job = await prisma.createJob.findFirst({
      where: {
        id: jobId,
        ownerAccountId,
      },
    });

    if (!job) return null;

    // Check if expired
    if (job.expiresAt && job.expiresAt < new Date()) return null;

    // Terminal state — return immediately
    if (isTerminal(job.status)) return job;

    // Wait for poll interval or remaining time, whichever is shorter
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }

  // Timeout — return current status
  return prisma.createJob.findFirst({
    where: {
      id: jobId,
      ownerAccountId,
    },
  });
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface JobStatusResponse {
  jobId: string;
  status: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields that should be included in app/web source results. */
const APP_WEB_RESULT_FIELDS = new Set([
  "templateId",
  "provisioningInstanceId",
  "conversationId",
  "inboxId",
]);

/** Fields that should be included in twitter source results. */
const TWITTER_RESULT_FIELDS = new Set([
  "templateId",
  "slug",
  "templateUrl",
  "replyText",
]);

/**
 * Filter result fields based on source type.
 * - Twitter source: includes templateId, slug, templateUrl, replyText
 * - App/web source: includes templateId, provisioningInstanceId, conversationId, inboxId
 */
const filterResultFields = (
  rawResult: Record<string, unknown>,
  source: string,
): Record<string, unknown> => {
  const allowedFields =
    source === "twitter" ? TWITTER_RESULT_FIELDS : APP_WEB_RESULT_FIELDS;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawResult)) {
    if (allowedFields.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
};

const buildResponse = (job: {
  id: string;
  status: string;
  source: string;
  result: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): JobStatusResponse => {
  const response: JobStatusResponse = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };

  if (job.status === "done" && job.result) {
    try {
      const rawResult = JSON.parse(job.result) as Record<string, unknown>;
      response.result = filterResultFields(rawResult, job.source);
    } catch {
      response.result = job.result;
    }
  }

  if (job.status === "failed" && job.error) {
    response.error = job.error;
  }

  return response;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function createJobGetHandler(req: Request, res: Response) {
  const { jobId } = req.params;

  // 1. Validate wait_ms query param
  const rawWaitMs = req.query.wait_ms;
  let waitMs = 0;

  if (rawWaitMs !== undefined) {
    const parsed = waitMsSchema.safeParse(rawWaitMs);
    if (!parsed.success) {
      res.status(400).json({
        error: "wait_ms must be a non-negative integer",
      });
      return;
    }
    waitMs = Math.min(parsed.data, MAX_WAIT_MS);
  }

  // 2. Determine ownerAccountId from auth context
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // 3. Fetch job (with optional long-polling)
  let job;

  if (waitMs > 0) {
    job = await waitForTerminalStatus(jobId, ownerAccountId, waitMs);
  } else {
    job = await prisma.createJob.findFirst({
      where: {
        id: jobId,
        ownerAccountId,
      },
    });

    // Check if expired
    if (job && job.expiresAt && job.expiresAt < new Date()) {
      job = null;
    }
  }

  // 4. Not found or expired → 404
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // 5. Build and return response
  res.status(200).json(buildResponse(job));
}
