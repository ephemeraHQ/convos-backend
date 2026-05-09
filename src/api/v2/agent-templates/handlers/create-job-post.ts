/**
 * Handler for POST /api/v2/agent-templates/create-job
 *
 * Creates an async job for generating + provisioning an agent template.
 *
 * Flow:
 *   1. Validate input (text|pdfBase64|imageBase64 required + joinUrl required)
 *   2. Create CreateJob row (status=pending)
 *   3. Fire background executor (void return)
 *   4. Return 202 { jobId }
 *
 * Auth: authOrAgentApiKeyAuth (JWT or X-Agent-API-Key)
 * Production guard: XMTP_ENV !== "production" (in v2/index.ts)
 * Body size: 40mb limit (route-specific middleware)
 * Input limits: text ≤ 50,000 chars, base64 ≤ 35,000,000 chars
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { executeCreateJob } from "@/api/v2/agent-templates/services/job-executor";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;
const MAX_BODY_BYTES = 40 * 1024 * 1024;

/** Format a number with commas for error messages. */
const fmtNum = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const createJobBodySchema = z
  .object({
    text: z.string().optional(),
    pdfBase64: z.string().optional(),
    imageBase64: z.string().optional(),
    mimeType: z.string().optional(),
    joinUrl: z
      .string({ required_error: "joinUrl is required" })
      .min(1, "joinUrl is required"),
  })
  .passthrough();

type CreateJobBody = z.infer<typeof createJobBodySchema>;

// ---------------------------------------------------------------------------
// Input coalescing — same priority as generate-template handler
// ---------------------------------------------------------------------------

type CoalescedInput =
  | { kind: "text"; text: string }
  | { kind: "pdfBase64"; pdfBase64: string; mimeType?: string }
  | { kind: "imageBase64"; imageBase64: string; mimeType?: string };

const coalesceInput = (body: CreateJobBody): CoalescedInput | null => {
  if (body.pdfBase64) {
    return {
      kind: "pdfBase64",
      pdfBase64: body.pdfBase64,
      mimeType: body.mimeType,
    };
  }

  if (body.imageBase64) {
    return {
      kind: "imageBase64",
      imageBase64: body.imageBase64,
      mimeType: body.mimeType,
    };
  }

  if (body.text && body.text.trim().length > 0) {
    return { kind: "text", text: body.text };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function createJobPostHandler(req: Request, res: Response) {
  // 1. Check Content-Length for 40mb body limit
  const contentLength = parseInt(req.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }

  // 2. Validate body shape with zod
  const parsed = createJobBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    // Build a user-friendly error message
    let errorMessage = "Invalid request body";
    if (
      firstIssue.path.includes("joinUrl") &&
      firstIssue.message === "joinUrl is required"
    ) {
      errorMessage = "joinUrl is required";
    } else if (
      firstIssue.code === "invalid_type" &&
      firstIssue.path.length > 0
    ) {
      const fieldName = firstIssue.path.join(".");
      errorMessage = `${fieldName} ${firstIssue.message}`;
    }
    res.status(400).json({
      error: errorMessage,
      details: parsed.error.issues,
    });
    return;
  }

  const body = parsed.data;

  // 3. Ensure at least one input field is provided
  const coalesced = coalesceInput(body);

  if (!coalesced) {
    res.status(400).json({
      error: "One of text, pdfBase64, or imageBase64 is required",
    });
    return;
  }

  // 4. Validate input lengths
  if (coalesced.kind === "text" && coalesced.text.length > MAX_TEXT_LEN) {
    res.status(400).json({
      error: `Text exceeds maximum length of ${fmtNum(MAX_TEXT_LEN)} characters`,
    });
    return;
  }

  if (
    coalesced.kind === "pdfBase64" &&
    coalesced.pdfBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `PDF base64 exceeds maximum length of ${fmtNum(MAX_BASE64_LEN)} characters`,
    });
    return;
  }

  if (
    coalesced.kind === "imageBase64" &&
    coalesced.imageBase64.length > MAX_BASE64_LEN
  ) {
    res.status(400).json({
      error: `Image base64 exceeds maximum length of ${fmtNum(MAX_BASE64_LEN)} characters`,
    });
    return;
  }

  // 5. Determine ownerAccountId from auth context
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // 6. Create CreateJob row
  const input = JSON.stringify(body);

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      input,
      ownerAccountId,
    },
  });

  // 7. Fire background executor — fire-and-forget
  void executeCreateJob(job.id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[create-job] Background executor failed for job ${job.id}: ${message}`,
    );
  });

  // 8. Return 202 { jobId }
  res.status(202).json({ jobId: job.id });
}
