/**
 * Handler for POST /api/v2/agent-templates/create-job
 *
 * Creates an async job for generating + provisioning an agent template.
 *
 * Flow (app/web source):
 *   1. Validate input (text|pdfBase64|imageBase64 required + joinUrl required)
 *   2. Create CreateJob row (status=pending)
 *   3. Fire background executor (void return)
 *   4. Return 202 { jobId }
 *
 * Flow (twitter source):
 *   1. Validate twitter-specific metadata (idea, twitterHandle, tweetId)
 *   2. Run synchronous moderation gate → 422 if blocked/not-agent-request
 *   3. Create CreateJob row (status=pending, source=twitter, metadata=JSON)
 *   4. Fire background executor (void return)
 *   5. Return 202 { jobId }
 *
 * Auth: authOrAgentApiKeyAuth (JWT or X-Agent-API-Key)
 * Production guard: XMTP_ENV !== "production" (in v2/index.ts)
 * Body size: 40mb limit (route-specific middleware)
 * Input limits: text ≤ 50,000 chars, base64 ≤ 35,000,000 chars, idea ≤ 4,000 chars
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { executeCreateJob } from "@/api/v2/agent-templates/services/job-executor";
import { moderateContent } from "@/api/v2/agent-templates/services/twitterModeration";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_IDEA_LEN = 4_000;

/** Twitter handle regex: optional @ prefix, then 1-15 alphanumeric/underscore chars. */
const TWITTER_HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;

/** Format a number with commas for error messages. */
const fmtNum = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Schema for twitter-specific metadata in the request body. */
const twitterMetadataSchema = z.object({
  idea: z.string(),
  twitterHandle: z.string(),
  tweetId: z.string(),
});

type TwitterMetadata = z.infer<typeof twitterMetadataSchema>;

/** Schema for app/web source jobs — requires joinUrl. */
const appWebBodySchema = z
  .object({
    source: z.enum(["app", "web"]).optional().default("app"),
    text: z.string().optional(),
    pdfBase64: z.string().optional(),
    imageBase64: z.string().optional(),
    mimeType: z.string().optional(),
    joinUrl: z
      .string({ required_error: "joinUrl is required" })
      .min(1, "joinUrl is required"),
  })
  .passthrough();

/** Schema for twitter source jobs — joinUrl NOT required, metadata required. */
const twitterBodySchema = z
  .object({
    source: z.literal("twitter"),
    metadata: twitterMetadataSchema,
    joinUrl: z.string().optional(),
  })
  .passthrough();

type AppWebBody = z.infer<typeof appWebBodySchema>;
type _TwitterBody = z.infer<typeof twitterBodySchema>;

// ---------------------------------------------------------------------------
// Input coalescing — same priority as generate-template handler
// ---------------------------------------------------------------------------

type CoalescedInput =
  | { kind: "text"; text: string }
  | { kind: "pdfBase64"; pdfBase64: string; mimeType?: string }
  | { kind: "imageBase64"; imageBase64: string; mimeType?: string };

const coalesceInput = (body: AppWebBody): CoalescedInput | null => {
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
// Twitter-specific validation
// ---------------------------------------------------------------------------

/** Strip Twitter mention syntax (@bot @bot2) from an idea string. */
const stripMentions = (idea: string): string =>
  idea
    .split(/\s+/)
    .filter((word) => !word.match(/^@(\w){1,15}$/))
    .join(" ")
    .trim();

/** Validate twitter metadata fields. Returns error message or null. */
const validateTwitterMetadata = (metadata: TwitterMetadata): string | null => {
  // 1. idea must be non-empty after stripping mentions
  const strippedIdea = stripMentions(metadata.idea);
  if (!strippedIdea || strippedIdea.length === 0) {
    return "idea is required (non-empty after stripping mentions)";
  }

  // 2. idea length limit
  if (metadata.idea.length > MAX_IDEA_LEN) {
    return `idea exceeds maximum length of ${fmtNum(MAX_IDEA_LEN)} characters`;
  }

  // 3. twitterHandle format
  if (!TWITTER_HANDLE_RE.test(metadata.twitterHandle)) {
    return "twitterHandle must match format @handle (1-15 alphanumeric/underscore characters, optional @ prefix)";
  }

  // 4. tweetId must be numeric
  if (!/^\d+$/.test(metadata.tweetId)) {
    return "tweetId must be a numeric string";
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

  // 2. Branch on source field
  const rawSource = req.body?.source as string | undefined;

  if (rawSource === "twitter") {
    // ── Twitter source flow ──
    return handleTwitterSource(req, res);
  }

  // ── App/web source flow (existing behavior) ──
  return handleAppWebSource(req, res);
}

// ---------------------------------------------------------------------------
// App/web source handler (existing behavior, refactored)
// ---------------------------------------------------------------------------

async function handleAppWebSource(req: Request, res: Response) {
  // Validate body shape with zod
  const parsed = appWebBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
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

  // Ensure at least one input field is provided
  const coalesced = coalesceInput(body);

  if (!coalesced) {
    res.status(400).json({
      error: "One of text, pdfBase64, or imageBase64 is required",
    });
    return;
  }

  // Validate input lengths
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

  // Determine ownerAccountId from auth context
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // Create CreateJob row
  const input = JSON.stringify(body);
  const source = body.source;

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      source,
      input,
      joinUrl: body.joinUrl,
      ownerAccountId,
    },
  });

  // Fire background executor — fire-and-forget
  void executeCreateJob(job.id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[create-job] Background executor failed for job ${job.id}: ${message}`,
    );
  });

  // Return 202 { jobId }
  res.status(202).json({ jobId: job.id });
}

// ---------------------------------------------------------------------------
// Twitter source handler (new)
// ---------------------------------------------------------------------------

async function handleTwitterSource(req: Request, res: Response) {
  // 1. Validate body shape with zod
  const parsed = twitterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    let errorMessage = "Invalid request body";
    if (firstIssue.path.includes("metadata")) {
      const metaPath = firstIssue.path.slice(1).join(".");
      if (metaPath === "idea") {
        errorMessage = "idea is required in metadata";
      } else if (metaPath === "twitterHandle") {
        errorMessage = "twitterHandle is required in metadata";
      } else if (metaPath === "tweetId") {
        errorMessage = "tweetId is required in metadata";
      } else {
        errorMessage = `metadata.${metaPath} ${firstIssue.message}`;
      }
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

  // 2. Validate twitter-specific metadata fields
  const validationError = validateTwitterMetadata(body.metadata);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  // 3. Determine ownerAccountId from auth context
  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // 4. Synchronous moderation gate
  const moderationResult = await moderateContent(body.metadata.idea);

  if (!moderationResult.allowed) {
    res.status(422).json({ reason: moderationResult.reason });
    return;
  }

  // 5. Create CreateJob row
  const input = JSON.stringify({
    source: "twitter",
    metadata: body.metadata,
    joinUrl: body.joinUrl ?? null,
  });

  const metadataJson = JSON.stringify({
    idea: body.metadata.idea,
    twitterHandle: body.metadata.twitterHandle,
    tweetId: body.metadata.tweetId,
  });

  const job = await prisma.createJob.create({
    data: {
      status: "pending",
      source: "twitter",
      input,
      metadata: metadataJson,
      joinUrl: body.joinUrl ?? null,
      ownerAccountId,
    },
  });

  // 6. Fire background executor — fire-and-forget
  void executeCreateJob(job.id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[create-job-twitter] Background executor failed for job ${job.id}: ${message}`,
    );
  });

  // 7. Return 202 { jobId }
  res.status(202).json({ jobId: job.id });
}
