/**
 * Generation Executor — runs the async pipeline for AgentTemplateGeneration.
 *
 * Pipeline:
 *   1. Atomic claim    — UPDATE WHERE status=pending → running. Bails if already claimed.
 *   2. Generate        — callGenerateTemplate(inputs) via OpenRouter
 *   3. Persist         — create AgentTemplate row, set generation.templateId
 *   4. Mark done       — status=done, expiresAt set (TTL window)
 *
 * On any stage failure: mark failed with stage-tagged error message,
 * still set expiresAt so the TTL sweep cleans up.
 *
 * Time budget: 5 minutes per generation. If exceeded, mark failed.
 * Process crash recovery is handled separately by the stuck-row sweep
 * in ttl-sweep.ts (UPDATE WHERE status=running AND updatedAt < NOW() - 10min).
 *
 * Test seam: __resetGenerationExecutorForTests(override | null) lets tests
 * stub the entire executor. __setExecutorTimeoutMsForTests(ms | null)
 * overrides the per-generation timeout.
 */

import { Prisma } from "@prisma/client";
import {
  isSlugExhaustionError,
  pickCollisionFreeId,
} from "@/api/v2/agent-templates/lib/pick-collision-free-id";
import { capturePostHog } from "@/api/v2/agent-templates/services/posthog";
import {
  callGenerateTemplate,
  getModel,
  type GenerateTemplateInput,
} from "@/api/v2/agent-templates/services/templateGen";
import { GENERATION_EXECUTOR_TIMEOUT_MS, GENERATION_TTL_HOURS } from "@/config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function getTtlMs(): number {
  return GENERATION_TTL_HOURS * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export type GenerationExecutorOverride = (
  generationId: string,
) => Promise<void>;

let _override: GenerationExecutorOverride | null = null;
let _timeoutMsOverride: number | null = null;

/**
 * Install a test override for the executor entrypoint.
 * Pass `null` to restore normal behaviour.
 */
export function __resetGenerationExecutorForTests(
  override: GenerationExecutorOverride | null,
): void {
  _override = override;
}

/**
 * Override the per-generation timeout for tests.
 * Pass `null` to restore the default
 * (`GENERATION_EXECUTOR_TIMEOUT_MS` from config, default 5 min).
 *
 * `GENERATION_EXECUTOR_TIMEOUT_MS` is distinct from
 * `GENERATION_STUCK_SWEEP_THRESHOLD_MS` in ttl-sweep.ts, which is the
 * out-of-band cutoff for marking abandoned `running` rows as failed.
 */
export function __setExecutorTimeoutMsForTests(ms: number | null): void {
  _timeoutMsOverride = ms;
}

function getTimeoutMs(): number {
  return _timeoutMsOverride !== null
    ? _timeoutMsOverride
    : GENERATION_EXECUTOR_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Inputs persisted to AgentTemplateGeneration.inputs
// ---------------------------------------------------------------------------

interface GenerationInputs {
  text?: string;
  idea?: string;
  content?: string;
  url?: string;
  pdfBase64?: string;
  imageBase64?: string;
  mimeType?: string;
  filename?: string;
}

// ---------------------------------------------------------------------------
// Input coalescing — same priority as today's generate-template handler
// ---------------------------------------------------------------------------

function coalesceInputs(
  inputs: GenerationInputs,
): GenerateTemplateInput | null {
  if (inputs.pdfBase64) {
    return {
      pdfBase64: inputs.pdfBase64,
      mimeType: inputs.mimeType || "application/pdf",
      filename: inputs.filename || "document.pdf",
    };
  }
  if (inputs.imageBase64) {
    return {
      imageBase64: inputs.imageBase64,
      mimeType: inputs.mimeType || "image/png",
    };
  }
  const text = inputs.text || inputs.idea || inputs.content || inputs.url;
  if (text && text.trim().length > 0) return { text };
  return null;
}

// ---------------------------------------------------------------------------
// Persist stage helper — creates the AgentTemplate row
// ---------------------------------------------------------------------------

const deriveBaseSlug = (agentName: string): string =>
  agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Max attempts to auto-pick a non-conflicting slug. Matches the CRUD
 *  handler's MAX_AUTO_SLUG_ATTEMPTS so generated templates use the same
 *  retry semantics on per-owner slug conflicts. */
const MAX_AUTO_SLUG_ATTEMPTS = 50;

function isSlugUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("ownerAccountId") && target.includes("slug");
  }
  return typeof target === "string" && target.includes("slug");
}

/** Persist the LLM-generated template as a draft AgentTemplate.
 *
 *  Slug policy mirrors the CRUD handler (handlers/create.ts):
 *  - Stores the **base slug** (e.g. "brewski"). The public hashed-slug URL
 *    is reconstructed by callers via `buildSlug(row.slug, row.id)` and the
 *    resolver in `resolve-id-or-hashed-slug.ts` queries `where: { slug: baseSlug }`.
 *    Storing the hashed form would make these rows unreachable via the resolver.
 *  - The row `id` is pre-picked via `pickCollisionFreeId` so its `slugHash(id)`
 *    doesn't collide with any existing row sharing `baseSlug` across owners.
 *    Without this, two owners on the same base could mint indistinguishable
 *    `<base>.<hash>` URLs, and the resolver would 404 (multiple matches).
 *  - On per-owner slug conflict (already-taken base), retry with `-2`, `-3`,
 *    ... up to MAX_AUTO_SLUG_ATTEMPTS. If `pickCollisionFreeId` exhausts its
 *    own 8-attempt budget on a given base, advance to the next `-N` too. */
async function persistTemplate(
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
  publishStatus: "draft" | "unlisted" | "published",
): Promise<{ id: string; slug: string }> {
  const baseSlug = deriveBaseSlug(template.agentName);
  // Non-draft submissions land in their target status with firstPublishedAt
  // stamped at insert time, so the caller doesn't need a follow-up
  // POST /:id/publish to make the template reachable by URL. Once
  // firstPublishedAt is set the slug becomes immutable per the patch
  // handler's SLUG_IMMUTABLE rule — same lock as if publish had run.
  const firstPublishedAt = publishStatus === "draft" ? null : new Date();

  for (let attempt = 0; attempt <= MAX_AUTO_SLUG_ATTEMPTS; attempt++) {
    if (attempt === 1) continue; // skip "-1"; first numeric suffix is "-2"

    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;

    let id: string;
    try {
      id = await pickCollisionFreeId({ baseSlug: candidate });
    } catch (err) {
      // 8-attempt hash-collision budget exhausted on this base. Move on
      // to the next -N suffix; the new base has a fresh hash-space.
      if (isSlugExhaustionError(err)) continue;
      throw err;
    }

    try {
      await prisma.agentTemplate.create({
        data: {
          id,
          slug: candidate,
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
          firstPublishedAt,
          status: publishStatus,
          featured: false,
        },
      });
      return { id, slug: candidate };
    } catch (err) {
      if (isSlugUniqueConstraintError(err)) continue;
      throw err;
    }
  }

  throw new Error(
    `Could not auto-pick a non-conflicting slug after ${MAX_AUTO_SLUG_ATTEMPTS} attempts (base: ${baseSlug})`,
  );
}

// ---------------------------------------------------------------------------
// Stage runner — atomic claim + pipeline + terminal write
// ---------------------------------------------------------------------------

async function tryClaim(generationId: string): Promise<boolean> {
  const claim = await prisma.agentTemplateGeneration.updateMany({
    where: { id: generationId, status: "pending" },
    data: { status: "running" },
  });
  return claim.count === 1;
}

/** Mark a generation `done`. Conditional on status='running' so a pipeline
 *  that finishes AFTER the per-generation timeout already fired markFailed
 *  no-ops instead of resurrecting the row. Returns true if the row was
 *  actually updated. */
async function markDone(
  generationId: string,
  templateId: string,
): Promise<boolean> {
  const result = await prisma.agentTemplateGeneration.updateMany({
    where: { id: generationId, status: "running" },
    data: {
      status: "done",
      templateId,
      expiresAt: new Date(Date.now() + getTtlMs()),
    },
  });
  return result.count === 1;
}

/** Mark a generation `failed`. Conditional on status='running' so a pipeline
 *  that gets the success markDone in first wins; this no-ops on a 0-row update. */
async function markFailed(generationId: string, error: string): Promise<void> {
  try {
    await prisma.agentTemplateGeneration.updateMany({
      where: { id: generationId, status: "running" },
      data: {
        status: "failed",
        error,
        expiresAt: new Date(Date.now() + getTtlMs()),
      },
    });
  } catch (err) {
    logger.error(
      { err, generationId },
      "[generation-executor] markFailed failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Execute one generation end-to-end. Fire-and-forget from handlers.
 *
 * Safe to call concurrently for the same generationId — only one caller
 * will claim it via the atomic UPDATE; the rest no-op.
 */
export async function executeGeneration(generationId: string): Promise<void> {
  if (_override) return _override(generationId);
  return _executeGeneration(generationId);
}

async function _executeGeneration(generationId: string): Promise<void> {
  // 1. Atomic claim
  const claimed = await tryClaim(generationId);
  if (!claimed) {
    logger.debug(
      { generationId },
      "[generation-executor] Not claimed (already running or terminal)",
    );
    return;
  }

  // 2. Race against the per-generation timeout. When the timeout fires we
  // ALSO abort the AbortController whose signal is threaded through
  // callGenerateTemplate → templateGen → OpenRouter fetches. That cancels
  // the in-flight LLM call so we stop paying tokens for a result we'd
  // discard. Pre-abort change: the LLM call ran to completion in the
  // background after timeout, persisted an orphan AgentTemplate, and then
  // no-opped on markDone. Post-abort change: fetch rejects with AbortError
  // shortly after timeout; orphan-template path becomes rare.
  const timeoutMs = getTimeoutMs();
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      _runPipeline(generationId, abortController.signal),
      timeout,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, generationId }, "[generation-executor] Pipeline failed");
    await markFailed(generationId, message);
  } finally {
    clearTimeout(timer);
    // Defensive: ensure the signal is aborted in any return path so a
    // background _runPipeline that hasn't yet checked the signal stops
    // soon (the abort propagates to outstanding fetches).
    if (!abortController.signal.aborted) abortController.abort();
  }
}

async function _runPipeline(
  generationId: string,
  signal: AbortSignal,
): Promise<void> {
  // Reload to get the latest inputs + ownerAccountId + source
  const generation = await prisma.agentTemplateGeneration.findUnique({
    where: { id: generationId },
  });
  if (!generation) {
    throw new Error("Generation row not found");
  }
  if (generation.status !== "running") {
    // Race lost between tryClaim and findUnique (shouldn't happen, but guard)
    throw new Error(
      `Generation status is ${generation.status}, expected running`,
    );
  }

  // 3. Generate stage
  const inputs = generation.inputs as GenerationInputs;
  const coalesced = coalesceInputs(inputs);
  if (!coalesced) {
    throw new Error(
      "No usable input — provide one of text, idea, content, url, pdfBase64, or imageBase64",
    );
  }
  const inputType: "text" | "pdfBase64" | "imageBase64" =
    "text" in coalesced
      ? "text"
      : "pdfBase64" in coalesced
        ? "pdfBase64"
        : "imageBase64";

  const startTime = performance.now();
  let templateResult: Awaited<ReturnType<typeof callGenerateTemplate>>;
  try {
    templateResult = await callGenerateTemplate(coalesced, signal);
  } catch (err) {
    // Meter error path
    capturePostHog({
      model: getModel(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Math.round(performance.now() - startTime),
      requestId: generationId,
      source: generation.source,
      ownerAccountId: generation.ownerAccountId,
      inputType,
      outcome: "failed",
    });
    throw new Error(
      `Generate stage failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Persist stage
  //
  // The Prisma column is the full PublishStatus enum (which includes
  // `archived`), but only `draft`/`unlisted`/`published` are valid initial
  // states for a fresh template. The handler's zod schema enforces this on
  // the API path; the assertion here is defense-in-depth for any row
  // inserted directly into the DB.
  if (generation.publishStatus === "archived") {
    throw new Error(
      `Invalid initial publishStatus: "archived" — must be draft, unlisted, or published`,
    );
  }
  let persisted: { id: string; slug: string };
  try {
    persisted = await persistTemplate(
      templateResult.template,
      generation.ownerAccountId,
      generation.publishStatus,
    );
  } catch (err) {
    capturePostHog({
      ...templateResult.metrics,
      requestId: generationId,
      source: generation.source,
      ownerAccountId: generation.ownerAccountId,
      inputType,
      outcome: "failed",
    });
    throw new Error(
      `Persist stage failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Mark done (conditional on status=running). If markDone returns false,
  // the pipeline lost the race against the per-generation timeout — markFailed
  // has already set status=failed. Skip the success PostHog event so metering
  // matches the row's terminal state, AND clean up the AgentTemplate we just
  // created so it doesn't surface as an orphan draft in the user's template
  // list. The template was created microseconds ago by this same execution and
  // nothing else can hold a reference yet (generation.templateId is still NULL
  // because markDone no-opped), so the delete is safe.
  const claimed = await markDone(generationId, persisted.id);
  if (!claimed) {
    try {
      await prisma.agentTemplate.delete({ where: { id: persisted.id } });
      logger.warn(
        { generationId, templateId: persisted.id, slug: persisted.slug },
        "[generation-executor] Pipeline finished after timeout — orphan AgentTemplate deleted",
      );
    } catch (err) {
      // Defensive: if delete fails (FK race, row already gone, etc.), log
      // and continue. The orphan stays but the generation is already failed,
      // so we don't block the executor on cleanup. Operators can grep for
      // this error to find genuinely-stuck orphans.
      logger.error(
        { err, generationId, templateId: persisted.id, slug: persisted.slug },
        "[generation-executor] Pipeline finished after timeout — failed to clean up orphan AgentTemplate",
      );
    }
    capturePostHog({
      ...templateResult.metrics,
      requestId: generationId,
      source: generation.source,
      ownerAccountId: generation.ownerAccountId,
      inputType,
      outcome: "failed",
    });
    return;
  }

  capturePostHog({
    ...templateResult.metrics,
    requestId: generationId,
    source: generation.source,
    ownerAccountId: generation.ownerAccountId,
    inputType,
    outcome: "done",
  });
  logger.info(
    { generationId, templateId: persisted.id, slug: persisted.slug },
    "[generation-executor] Generation complete",
  );
}
