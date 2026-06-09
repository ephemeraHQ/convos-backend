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
 *   5. Owner resolution (auth account or admin fallback)
 *   6. Idempotency-Key header present                           → 400
 *   7. Idempotency lookup → existing { source, inputs } match   → respondPerMode
 *   8.                  → existing different body              → 409
 *   9. Content moderation (universal)                           → 422 (content)
 *   9b. Twitter intent moderation (when twitterContext present)  → 422 (intent)
 *  10. Persist row + fire executor + respondPerMode
 *
 * Idempotent replays go through the SAME respondPerMode path as the original
 * submit, so a retry with `Accept: text/event-stream` or `?wait_ms=` honours
 * the requested mode (the previous behaviour was to immediately return JSON
 * regardless of how the replay was framed).
 *
 * Auth: optionalAuthOrAgentApiKeyAuth. Anonymous submissions are accepted
 * and owned by ADMIN_ACCOUNT_ID; authenticated submissions are owned by
 * the JWT/API-key account.
 * Body size: 40 MB (route-specific middleware).
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { executeGeneration } from "@/api/v2/agent-templates/services/generation-executor";
import {
  checkContent,
  checkTwitterIntent,
} from "@/api/v2/agent-templates/services/moderation";
import { type TraceContext } from "@/api/v2/agent-templates/services/openrouter-client";
import { resolveActor } from "@/api/v2/agent-templates/services/posthog";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_LEN = 50_000;
const MAX_BASE64_LEN = 35_000_000;
// Builder/system prompt override cap — generous (the canonical file prompt is
// ~12k tokens) but bounds an obviously-abusive body.
const MAX_BUILDER_PROMPT_LEN = 100_000;
// Model-override cap — OpenRouter model ids are short slugs; this just bounds
// an obviously-abusive value (matches the column's VARCHAR(256)).
const MAX_BUILDER_MODEL_LEN = 256;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_WAIT_MS = 45_000;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

// RFC 4122 UUID format. Version digit is any 1-5 (accepts v4 random,
// v5 namespaced, etc.); variant nibble is 8/9/a/b.
const IDEMPOTENCY_KEY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Adaptive backoff for long-poll + SSE poll loops.
 *
 * See generations-get.ts for full rationale. TL;DR: 100 → 250 → 500 →
 * 1000 → 2000 ms reduces per-request DB queries from ~60 (constant 500ms
 * over a 30s generation) to ~25 with no architectural change.
 *
 * TODO(scale): replace polling with Postgres LISTEN/NOTIFY when long-poll
 * volume justifies the dedicated pg-client plumbing (~150 LOC).
 */
function nextPollIntervalMs(attempt: number): number {
  if (attempt < 2) return 100;
  if (attempt < 4) return 250;
  if (attempt < 8) return 500;
  if (attempt < 16) return 1000;
  return 2000;
}

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

/**
 * Twitter context for the optional ComposeReply pipeline stage.
 *
 * Trust boundary: this schema validates the *format* of `twitterHandle` and
 * `tweetId`, but does NOT verify ownership — i.e. it doesn't check that the
 * caller has the right to act as `@twitterHandle` or that `tweetId` was
 * authored by them. That verification MUST happen at the caller (the twitter
 * bot, which has access to the tweet author via the Twitter API). Passing
 * an unverified twitterHandle would let an attacker produce a reply
 * impersonating any handle, so the bot's pre-call check is load-bearing.
 *
 * The endpoint itself is reachable anonymously (optional auth), so
 * `twitterContext` is gated separately: the handler rejects the field
 * unless the caller authenticated with the agent API key
 * (`isApiKeyListener`). That means only the twitter bot — the one party
 * able to verify handle ownership — can attach this context.
 */
const twitterContextSchema = z
  .object({
    /** Twitter handle of the user who @mentioned the bot. Format-only check;
     *  caller is responsible for verifying ownership against the tweet author. */
    twitterHandle: z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, {
      message:
        "twitterHandle must match /^@?[A-Za-z0-9_]{1,15}$/ (1-15 alphanumeric/underscore, optional @ prefix)",
    }),
    /** ID of the tweet that triggered the request. Numeric string per Twitter's
     *  snowflake format. Caller is responsible for matching this against the
     *  authenticated request context. */
    tweetId: z.string().regex(/^\d+$/, {
      message: "tweetId must be a numeric string",
    }),
    /** Optional override for the moderation/reply input. Defaults to inputs.text. */
    idea: z.string().optional(),
  })
  .strict();

/**
 * Partial AgentTemplate the caller pins ahead of generation. The
 * generator respects these fields and fills in the rest — so callers
 * that already know what they want for any allowlisted slot can commit
 * it without depending on the model to echo the same value back. All
 * fields are optional; the executor only overlays the ones present.
 *
 * The allowlist is intentional — only fields the server lets a caller
 * pin appear here, and `.strict()` rejects anything else. New pinnable
 * fields (e.g. category, tools, forkedFromId for fork flows) get added
 * to this schema; the endpoint's wire signature stays stable.
 *
 * Length caps mirror the underlying `AgentTemplate` column expectations
 * but are otherwise lightly constrained — `agentName` is shown verbatim
 * in clients, but XSS sanitization is an output-time concern there.
 */
const TemplatePrefillSchema = z
  .object({
    agentName: z.string().trim().min(1).max(256).optional(),
    emoji: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    source: z.string().min(1, "source is required"),
    inputs: inputsSchema,
    twitterContext: twitterContextSchema.optional(),
    /** Stable per-client identifier used as the PostHog distinctId fallback
     *  when the request isn't authenticated (anonymous web/iOS, or the
     *  twitter-bot path before we wire Twitter user IDs). Web should pass
     *  posthog-js's `$device_id`. Capped at 128 chars to bound storage and
     *  prevent abuse — posthog-js generates a UUIDv7 (~36 chars). Excluded
     *  from the idempotency dedupe body comparison (`dedupeBodiesMatch`)
     *  so a retry with a rotated device ID still matches the original row. */
    clientDeviceId: z.string().trim().min(1).max(128).optional(),
    publishStatus: z
      .enum(["draft", "unlisted", "published"])
      .optional()
      .default("draft"),
    // Caller-pinned subset of the AgentTemplate fields — see
    // `TemplatePrefillSchema` above for semantics and the allowlist.
    // An empty `{}` is normalized to `undefined`: it overlays nothing,
    // so treating it differently from an omitted prefill would let two
    // logically identical requests collide on an Idempotency-Key (one
    // sending `{}`, one omitting) and store meaningless empty objects.
    prefill: TemplatePrefillSchema.optional().transform((v) =>
      v && Object.keys(v).length > 0 ? v : undefined,
    ),
    // Custom builder/system prompt that overrides the canonical template-
    // generator prompt for this generation. Privileged — gated to agent-API-key
    // callers below (like twitterContext) — and persisted on the row so the
    // fire-and-forget executor can feed it to the generator. The produced
    // template still lands as a draft via the normal pipeline.
    builderPrompt: z.string().min(1).max(MAX_BUILDER_PROMPT_LEN).optional(),
    // Custom model that overrides the default builder model for this
    // generation's main call. Privileged — gated to agent-API-key callers
    // below (like builderPrompt) — and persisted on the row so the
    // fire-and-forget executor can hand it to the generator.
    builderModel: z.string().min(1).max(MAX_BUILDER_MODEL_LEN).optional(),
    // Asserted owner — honoured only when the caller is agent-key-auth'd;
    // ignored for JWT (JWT account always wins) and anonymous (falls
    // back to ADMIN). See the owner-resolution block below.
    ownerAccountId: z.string().uuid().optional(),
  })
  .strict();

type Body = z.infer<typeof bodySchema>;
type Inputs = z.infer<typeof inputsSchema>;
export type TemplatePrefill = z.infer<typeof TemplatePrefillSchema>;

// ---------------------------------------------------------------------------
// Coalescing — for length validation; also used in executor at runtime
// ---------------------------------------------------------------------------

type CoalescedInput =
  | { kind: "text"; text: string }
  | { kind: "pdfBase64"; pdfBase64: string; text?: string }
  | { kind: "imageBase64"; imageBase64: string; text?: string };

function coalesceInputs(inputs: Inputs): CoalescedInput | null {
  // Pick the first text-bearing field whose content is non-whitespace.
  // A naive `||` chain short-circuits on truthy-but-whitespace values
  // (`"   "` is truthy in JS), so a payload like
  // `{ text: "   ", idea: "real prompt" }` would lose "real prompt" and
  // surface as a 400 instead of falling through to `idea`.
  const text = [inputs.text, inputs.idea, inputs.content, inputs.url].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  // The text rides along on file paths too — it's the user's directive for the
  // attached file — so carry it through for length validation, mirroring the
  // executor's coalescing.
  if (inputs.pdfBase64)
    return {
      kind: "pdfBase64",
      pdfBase64: inputs.pdfBase64,
      ...(text ? { text } : {}),
    };
  if (inputs.imageBase64)
    return {
      kind: "imageBase64",
      imageBase64: inputs.imageBase64,
      ...(text ? { text } : {}),
    };
  if (text) return { kind: "text", text };
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency body comparison — strict JSON equality after canonical sort
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sortedKeys = Object.keys(value).sort();
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

async function waitForTerminal(args: {
  generationId: string;
  ownerAccountId: string;
  waitMs: number;
  isClosed: () => boolean;
}): Promise<GenerationRow | null> {
  const deadline = Date.now() + args.waitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (args.isClosed()) return null;
    const row = await fetchOwnedGeneration(
      args.generationId,
      args.ownerAccountId,
    );
    if (!row) return null;
    if (isTerminal(row.status)) return row;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(nextPollIntervalMs(attempt), remaining)),
    );
    attempt += 1;
  }
  if (args.isClosed()) return null;
  return fetchOwnedGeneration(args.generationId, args.ownerAccountId);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

interface GenerationRow {
  id: string;
  status: string;
  templateId: string | null;
  reply: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GenerationResponse {
  generationId: string;
  status: string;
  templateId?: string;
  reply?: { text: string };
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
  if (row.reply) out.reply = { text: row.reply };
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
      reply: true,
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

async function streamUntilTerminal(args: {
  res: Response;
  keepalive: ReturnType<typeof setInterval>;
  generationId: string;
  ownerAccountId: string;
  /** Returns true once the client has hung up. We bail without writing further frames. */
  isClosed: () => boolean;
  /** Optional row already fetched (e.g. from the dedupe path). Avoids one extra
   *  query when the caller has a fresh snapshot. */
  initialRow?: GenerationRow;
}): Promise<void> {
  const { res, keepalive } = args;
  // Wrap the poll loop so errors after headers-flushed still produce a
  // recoverable terminal frame instead of leaving the client hanging.
  try {
    let firstIteration = true;
    let attempt = 0;
    for (;;) {
      if (args.isClosed() || res.writableEnded || res.destroyed) return;

      const row =
        firstIteration && args.initialRow
          ? args.initialRow
          : await fetchOwnedGeneration(args.generationId, args.ownerAccountId);
      firstIteration = false;

      if (!row) {
        const data = JSON.stringify({ error: "Generation not found" });
        res.write(`event: error\ndata: ${data}\n\n`);
        res.end();
        return;
      }
      if (isTerminal(row.status)) {
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

      await new Promise((resolve) =>
        setTimeout(resolve, nextPollIntervalMs(attempt)),
      );
      attempt += 1;
    }
  } catch (err) {
    // DB error mid-poll, or write threw after disconnect race. Emit a final
    // error frame if the stream is still live; otherwise just clean up.
    if (!res.writableEnded && !res.destroyed) {
      try {
        const data = JSON.stringify({
          error: err instanceof Error ? err.message : "Stream failed",
        });
        res.write(`event: error\ndata: ${data}\n\n`);
        res.end();
      } catch {
        // Swallow write-after-close
      }
    }
  } finally {
    clearInterval(keepalive);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Internal type for the idempotency dedupe lookup. Carries every field
 *  that influences the generator's output so the body comparison can
 *  detect cross-source / cross-tweet / cross-prefill key reuse (e.g.
 *  same Idempotency-Key with source="twitter-bot" vs source="ios-app",
 *  same key with different tweetIds, or same key with different caller-
 *  pinned prefills). */
interface DedupeRow extends GenerationRow {
  source: string;
  inputs: unknown;
  twitterContext: unknown;
  prefill: unknown;
  builderPrompt: string | null;
  builderModel: string | null;
}

const dedupeSelect = {
  id: true,
  source: true,
  inputs: true,
  twitterContext: true,
  prefill: true,
  builderPrompt: true,
  builderModel: true,
  status: true,
  templateId: true,
  reply: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Compare the full idempotent contract — every field that influences
 *  the generator's output or the persisted template's identity. A
 *  mismatch on any of them means the second caller wants a different
 *  result than the first, so we must 409 rather than silently hand back
 *  the first caller's row. */
function dedupeBodiesMatch(existing: DedupeRow, body: Body): boolean {
  return bodiesMatch(
    {
      source: existing.source,
      inputs: existing.inputs,
      twitterContext: existing.twitterContext,
      prefill: existing.prefill,
      builderPrompt: existing.builderPrompt,
      builderModel: existing.builderModel,
    },
    {
      source: body.source,
      inputs: body.inputs,
      twitterContext: body.twitterContext ?? null,
      prefill: body.prefill ?? null,
      builderPrompt: body.builderPrompt ?? null,
      builderModel: body.builderModel ?? null,
    },
  );
}

/** Pick the response mode (SSE / wait_ms long-poll / immediate JSON) and
 *  drive it to terminal. Used by the fresh-submit path, the dedupe path,
 *  and the insert-race dedupe path so idempotent replays honour the same
 *  Accept / wait_ms semantics as the original request. */
async function respondPerMode(args: {
  req: Request;
  res: Response;
  ownerAccountId: string;
  /** Latest known row state. Always present — caller has either just inserted
   *  it or just fetched it. */
  row: GenerationRow;
  isClosed: () => boolean;
}): Promise<void> {
  const { req, res, ownerAccountId, row, isClosed } = args;

  // SSE mode
  const accept = req.headers.accept || "";
  if (accept.includes("text/event-stream")) {
    // Terminal already? Skip the keepalive setup and just emit the terminal frame.
    if (isTerminal(row.status)) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
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

    const keepalive = startSseStream(res);
    await streamUntilTerminal({
      res,
      keepalive,
      generationId: row.id,
      ownerAccountId,
      isClosed,
      initialRow: row,
    });
    return;
  }

  // wait_ms long-poll
  const waitMs = parseWaitMs(req.query.wait_ms);
  if (waitMs > 0 && !isTerminal(row.status)) {
    const finalRow = await waitForTerminal({
      generationId: row.id,
      ownerAccountId,
      waitMs,
      isClosed,
    });
    if (isClosed() || res.writableEnded) return;
    if (!finalRow) {
      res.status(404).json({ error: "Generation not found" });
      return;
    }
    const httpStatus = isTerminal(finalRow.status) ? 200 : 202;
    res.status(httpStatus).json(toResponse(finalRow));
    return;
  }

  // Immediate JSON
  if (isClosed() || res.writableEnded) return;
  const httpStatus = isTerminal(row.status) ? 200 : 202;
  res.status(httpStatus).json(toResponse(row));
}

export async function generationsPostHandler(req: Request, res: Response) {
  // Track client disconnect so all blocking paths (SSE poll, wait_ms long-poll)
  // can bail early when nobody is listening.
  //
  // Use res.on("close") rather than req.on("close"): IncomingMessage's "close"
  // fires when the request body is fully consumed (i.e. almost immediately),
  // whereas ServerResponse's "close" only fires when the underlying connection
  // is terminated — which is what "client disconnected" actually means.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const isClosed = () => closed;

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
  // `coalesced.text` is set on the text path AND on file paths that carry an
  // intent directive, so cap it regardless of kind.
  if (coalesced.text !== undefined && coalesced.text.length > MAX_TEXT_LEN) {
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

  // 5. Owner account. Three branches:
  //
  //    - **Agent API key auth**: caller is a trusted system component
  //      (e.g. an agent runtime) authenticating as itself and asserting
  //      which user account to attribute the work to. Body `ownerAccountId`
  //      is the assertion; absent it, fall back to ADMIN. The assertion
  //      is validated against the Account table — invalid accountIds 400
  //      rather than silently landing on a phantom owner.
  //    - **JWT auth**: end user submitting through their own account.
  //      JWT account always wins; any `ownerAccountId` in the body is
  //      ignored (users can't assert ownership on behalf of others).
  //    - **Anonymous**: ADMIN seed account. Body `ownerAccountId` ignored.
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;
  let ownerAccountId: string;
  if (isApiKeyListener && body.ownerAccountId !== undefined) {
    const assertedAccountId = body.ownerAccountId;
    // Best-effort early validation — fail fast before the moderation
    // calls below spend API budget on a request we're going to reject.
    // The DB's FK constraint on `ownerAccountId → Account.id` is the
    // canonical source of truth; a P2003 from the insert (handled in
    // the catch block below) maps to the same 400 and covers the race
    // where the account is deleted between this check and the insert.
    const exists = await prisma.account.findUnique({
      where: { id: assertedAccountId },
      select: { id: true },
    });
    if (!exists) {
      res.status(400).json({
        error: "Asserted ownerAccountId does not exist",
      });
      return;
    }
    ownerAccountId = assertedAccountId;
  } else if (isApiKeyListener) {
    // Agent-key auth without an explicit assertion → keep the existing
    // default (the agent-key path historically resolves to ADMIN via
    // `authOrAgentApiKeyAuth`).
    ownerAccountId = ADMIN_ACCOUNT_ID;
  } else {
    ownerAccountId = getEffectiveOwnerId(res) ?? ADMIN_ACCOUNT_ID;
  }

  // 5b. twitterContext is privileged — it ends up attributed to a real
  //     twitter handle. Only the bot (agent API key) is in a position to
  //     verify handle ownership against the tweet author, so reject the
  //     field for anonymous and JWT-only callers.
  if (body.twitterContext && !isApiKeyListener) {
    res.status(403).json({
      error: "twitterContext requires agent API key authentication",
    });
    return;
  }

  // 5c. builderPrompt overrides the canonical generator system prompt — an
  //     abuse-prone surface (a free general-purpose LLM, or a way to strip the
  //     design/moderation guardrails baked into the canonical prompt), so it's
  //     restricted to agent-API-key callers (the admin dashboard).
  if (body.builderPrompt && !isApiKeyListener) {
    res.status(403).json({
      error: "builderPrompt requires agent API key authentication",
    });
    return;
  }

  // 5d. builderModel swaps the default builder model — same abuse surface
  //     (an arbitrary, potentially unguardrailed model), so it's restricted
  //     to agent-API-key callers like builderPrompt.
  if (body.builderModel && !isApiKeyListener) {
    res.status(403).json({
      error: "builderModel requires agent API key authentication",
    });
    return;
  }

  // 6. Idempotency-Key required and MUST be a UUID (any RFC 4122 version).
  //    Both the agent API key path and anonymous submissions are owned by
  //    `ADMIN_ACCOUNT_ID`, so they share an idempotency namespace; using
  //    UUIDs (122 bits of entropy) keeps that shared namespace safe from
  //    accidental and adversarial collisions — without UUIDs, an attacker
  //    could pick a key they know another caller will use and read back
  //    that caller's `generationId` (which is itself a bearer secret) via
  //    the dedupe path. Callers needing stable retries can derive a
  //    deterministic UUID from their external identifier (e.g. `uuidv5`
  //    of the tweet ID in the twitter bot's case).
  const idempotencyKey = req.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length === 0) {
    res.status(400).json({ error: "Idempotency-Key header required" });
    return;
  }
  if (!IDEMPOTENCY_KEY_UUID_RE.test(idempotencyKey)) {
    res.status(400).json({
      error: "Idempotency-Key must be a UUID",
    });
    return;
  }

  // 7+8. Idempotency dedupe lookup. Compare the FULL body (source + inputs);
  // same key with a different source is a 409, matching the docstring contract.
  const existing = await prisma.agentTemplateGeneration.findUnique({
    where: {
      ownerAccountId_idempotencyKey: { ownerAccountId, idempotencyKey },
    },
    select: dedupeSelect,
  });
  if (existing) {
    if (!dedupeBodiesMatch(existing, body)) {
      res.status(409).json({
        error: "Idempotency-Key reused with different body",
      });
      return;
    }
    // Same key + same body → return existing row through the same mode-selection
    // path as a fresh submit. This means a replay with Accept: text/event-stream
    // still gets an SSE stream, and ?wait_ms= still long-polls.
    await respondPerMode({ req, res, ownerAccountId, row: existing, isClosed });
    return;
  }

  // Pre-generate the generation id (same uuid format as the column default) so
  // the moderation LLM calls share a PostHog LLM Analytics trace with the
  // generation that follows. Passed as `id` to the create() below, and used as
  // the trace id by the executor (which keys traces on the generation id).
  // distinctId reuses the same actor ladder as the executor's product event so
  // moderation, generation, and the product event all attribute to one person.
  const generationId = randomUUID();
  const moderationActor = resolveActor({
    requestId: generationId,
    ownerAccountId,
    isAnonymous: ownerAccountId === ADMIN_ACCOUNT_ID,
    clientDeviceId: body.clientDeviceId ?? undefined,
    twitterUserId: body.twitterContext?.twitterHandle
      ? body.twitterContext.twitterHandle.toLowerCase().replace(/^@/, "")
      : undefined,
  });
  const moderationTrace: TraceContext = {
    traceId: generationId,
    distinctId: moderationActor.distinctId,
    properties: {
      generation_id: generationId,
      source: body.source,
      actor_kind: moderationActor.kind,
    },
  };

  // 9. Content moderation gate (universal)
  const moderationInput =
    coalesced.kind === "text"
      ? coalesced.text
      : `[binary input: ${coalesced.kind}, ${coalesced.kind === "pdfBase64" ? coalesced.pdfBase64.length : coalesced.imageBase64.length} bytes]`;
  const moderation = await checkContent(moderationInput, moderationTrace);
  if (!moderation.allowed) {
    res.status(422).json({
      reason: moderation.reason || "blocked",
      category: "content",
    });
    return;
  }

  // 9b. Twitter intent gate — only when twitterContext is present
  if (body.twitterContext) {
    const intentInput =
      body.twitterContext.idea ??
      (coalesced.kind === "text" ? coalesced.text : "");
    if (!intentInput || intentInput.trim().length === 0) {
      res.status(400).json({
        error:
          "twitterContext.idea or inputs.text required for twitter intent check",
      });
      return;
    }
    const intent = await checkTwitterIntent(intentInput, moderationTrace);
    if (!intent.allowed) {
      res.status(422).json({
        reason: intent.reason || "not_agent_request",
        category: "intent",
      });
      return;
    }
  }

  // 10. Persist + fire executor
  let created: GenerationRow;
  try {
    created = await prisma.agentTemplateGeneration.create({
      data: {
        id: generationId,
        ownerAccountId,
        source: body.source,
        idempotencyKey,
        inputs: body.inputs,
        twitterContext: body.twitterContext
          ? (body.twitterContext as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        clientDeviceId: body.clientDeviceId ?? null,
        prefill: body.prefill
          ? (body.prefill as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        builderPrompt: body.builderPrompt ?? null,
        builderModel: body.builderModel ?? null,
        publishStatus: body.publishStatus,
        status: "pending",
      },
      select: {
        id: true,
        status: true,
        templateId: true,
        reply: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    // Race: another request created with the same key between our lookup
    // and insert. Re-fetch and treat as the dedupe path (same mode selection).
    const racedRow = await prisma.agentTemplateGeneration.findUnique({
      where: {
        ownerAccountId_idempotencyKey: { ownerAccountId, idempotencyKey },
      },
      select: dedupeSelect,
    });
    if (racedRow) {
      if (!dedupeBodiesMatch(racedRow, body)) {
        res.status(409).json({
          error: "Idempotency-Key reused with different body",
        });
        return;
      }
      await respondPerMode({
        req,
        res,
        ownerAccountId,
        row: racedRow,
        isClosed,
      });
      return;
    }
    // Race: the asserted owner account was deleted between our
    // pre-check (`account.findUnique` in the owner-resolution block)
    // and this insert, so the FK constraint fires. Map back to the
    // documented 400 so the caller sees a consistent error code
    // regardless of race timing — the only FK on this row that can
    // miss in practice is `ownerAccountId → Account.id`.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      res.status(400).json({
        error: "Asserted ownerAccountId does not exist",
      });
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

  // 11. Response mode (fresh submit, status=pending)
  await respondPerMode({ req, res, ownerAccountId, row: created, isClosed });
}
