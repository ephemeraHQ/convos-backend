/**
 * Generation Executor — runs the async pipeline for AgentTemplateGeneration.
 *
 * Pipeline:
 *   1. Atomic claim     — UPDATE WHERE status=pending → running. Bails if already claimed.
 *   2. Generate         — callGenerateTemplate(inputs) via OpenRouter
 *   3. Persist          — create AgentTemplate row, set generation.templateId
 *   4. ComposeReply (opt) — only when twitterContext is present. composeReply()
 *                          falls back to deterministic text on LLM failure, so this
 *                          stage never fails the generation — failure just yields
 *                          fallback reply text and we proceed to done.
 *   5. Mark done        — status=done, reply (or null), expiresAt set (TTL window)
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

import { pickCollisionFreeId } from "@/api/v2/agent-templates/lib/pick-collision-free-id";
import {
  buildDeterministicFallback,
  composeReply,
} from "@/api/v2/agent-templates/services/compose-reply";
import {
  capturePostHog,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";
import {
  callGenerateTemplate,
  getModel,
  type GenerateTemplateInput,
} from "@/api/v2/agent-templates/services/templateGen";
import { GENERATION_EXECUTOR_TIMEOUT_MS, GENERATION_TTL_HOURS } from "@/config";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { validateSlug } from "@/utils/reserved-slugs";
import { buildUrlSlug } from "@/utils/slug-hash";

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

interface TwitterContext {
  twitterHandle: string;
  tweetId: string;
  idea?: string;
}

// Caller-pinned partial AgentTemplate — see `TemplatePrefillSchema` in
// `handlers/generations-post.ts` for the wire shape and allowlist.
// Stored on the generation row's `prefill` JSON column; applied here at
// the persist stage so the AgentTemplate uses the caller's pinned values.
interface TemplatePrefill {
  agentName?: string;
  emoji?: string;
  description?: string;
}

function applyPrefill<
  T extends { agentName: string; emoji: string; description: string },
>(template: T, prefill: TemplatePrefill | null): T {
  if (prefill === null) return template;
  return {
    ...template,
    ...(prefill.agentName !== undefined
      ? { agentName: prefill.agentName }
      : {}),
    ...(prefill.emoji !== undefined ? { emoji: prefill.emoji } : {}),
    ...(prefill.description !== undefined
      ? { description: prefill.description }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// PostHog actor-attribution fields — shared across every capture site
// ---------------------------------------------------------------------------

/** Generation row shape consumed by `postHogBase` — the actor-attribution
 *  inputs only. Declared as a structural subset of the Prisma row so this
 *  helper is decoupled from the full schema. */
interface PostHogActorSource {
  ownerAccountId: string;
  source: string;
  twitterContext: unknown;
  clientDeviceId: string | null;
}

/**
 * Build the actor-attribution + always-on fields shared across every
 * PostHog capture site in this pipeline. Centralised so the four sites
 * (generate-fail, persist-fail, timeout-race-fail, success) stay in sync —
 * adding a new actor signal only needs one edit here.
 *
 * `isAnonymous` is derived from the admin-account sentinel: anonymous
 * submissions are owned by `ADMIN_ACCOUNT_ID` so the row has a valid
 * owner FK, but the value is a system identity, not a real user.
 * `resolveActor` in posthog.ts skips ownerAccountId when this is set.
 */
function postHogBase(args: {
  generation: PostHogActorSource;
  requestId: string;
  inputType: "text" | "pdfBase64" | "imageBase64";
}): Pick<
  PostHogCaptureProperties,
  | "requestId"
  | "inputType"
  | "source"
  | "ownerAccountId"
  | "isAnonymous"
  | "clientDeviceId"
  | "twitterUserId"
> {
  const { generation, requestId, inputType } = args;
  const twitterCtx = generation.twitterContext as TwitterContext | null;
  return {
    requestId,
    inputType,
    source: generation.source,
    ownerAccountId: generation.ownerAccountId,
    isAnonymous: generation.ownerAccountId === ADMIN_ACCOUNT_ID,
    clientDeviceId: generation.clientDeviceId ?? undefined,
    // Lowercase + strip optional leading `@` so handle casing/format drift
    // on the Twitter side doesn't fragment a single user across multiple
    // PostHog persons. We don't currently have a stable numeric user ID
    // from the twitter bot — once it's threaded through, replace this with
    // `twitter:<numericUserId>` for true rename-resilient attribution.
    twitterUserId: twitterCtx?.twitterHandle
      ? twitterCtx.twitterHandle.toLowerCase().replace(/^@/, "")
      : undefined,
  };
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

/** Fallback slug used when an agentName doesn't yield a valid base slug.
 *  Slugs are non-unique, so a shared fallback is fine — the hashed URL
 *  still disambiguates each row. Must itself pass `validateSlug`. */
const FALLBACK_SLUG = "agent";

// Fail fast at module load if FALLBACK_SLUG ever stops being a valid slug —
// e.g. "agent" gets added to RESERVED_SLUGS, or the slug rules tighten.
// Without this guard, deriveTemplateSlug would silently fall back to an
// invalid slug and persist unreachable rows. A startup crash is the loud,
// debuggable failure mode instead.
{
  const fallbackCheck = validateSlug(FALLBACK_SLUG);
  if (!fallbackCheck.valid) {
    throw new Error(
      `FALLBACK_SLUG "${FALLBACK_SLUG}" is not a valid slug: ${fallbackCheck.message}`,
    );
  }
}

/** Derive a persistable slug from the generated agentName.
 *
 *  `deriveBaseSlug` can yield an empty (emoji-only / non-Latin name),
 *  reserved ("Generate" → "generate"), or malformed string. The CRUD
 *  create handler rejects those with a 400, but the async pipeline has no
 *  caller to reject to — and an empty slug would make the row unreachable
 *  via its hashed URL. So fall back to `FALLBACK_SLUG` rather than failing
 *  the generation or persisting a broken slug. */
function deriveTemplateSlug(agentName: string): string {
  const validated = validateSlug(deriveBaseSlug(agentName));
  return validated.valid ? validated.slug : FALLBACK_SLUG;
}

/** Persist the LLM-generated template as a draft AgentTemplate.
 *
 *  Slug policy mirrors the CRUD handler (handlers/create.ts):
 *  - Stores the **base slug** (e.g. "brewski"). The public hashed-slug URL
 *    is reconstructed by callers via `buildUrlSlug(row.slug, row.id)` and the
 *    resolver in `resolve-id-or-url-slug.ts` queries `where: { slug: baseSlug }`.
 *    Storing the hashed form would make these rows unreachable via the resolver.
 *  - The slug is derived from agentName and run through `validateSlug`,
 *    falling back to `FALLBACK_SLUG` when the derivation is empty/reserved/
 *    malformed (see `deriveTemplateSlug`).
 *  - Slugs are NOT unique (no DB constraint). Any number of rows can share a
 *    base slug; the row `id` is pre-picked via `pickCollisionFreeId` so its
 *    `slugHash(id)` doesn't collide with any existing row sharing `baseSlug`,
 *    which is what keeps the public `<base>.<hash>` URL unambiguous. */
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
  const slug = deriveTemplateSlug(template.agentName);
  // Non-draft submissions land in their target status with firstPublishedAt
  // stamped at insert time, so the caller doesn't need a follow-up
  // POST /:id/publish to make the template reachable by URL. Once
  // firstPublishedAt is set the slug becomes immutable per the patch
  // handler's SLUG_IMMUTABLE rule — same lock as if publish had run.
  const firstPublishedAt = publishStatus === "draft" ? null : new Date();

  const id = await pickCollisionFreeId({ baseSlug: slug });
  await prisma.agentTemplate.create({
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
      firstPublishedAt,
      status: publishStatus,
      featured: false,
    },
  });
  return { id, slug };
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
  reply: string | null,
): Promise<boolean> {
  const result = await prisma.agentTemplateGeneration.updateMany({
    where: { id: generationId, status: "running" },
    data: {
      status: "done",
      templateId,
      reply,
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
      ...postHogBase({ generation, requestId: generationId, inputType }),
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
  // Caller-pinned prefill: when the caller pinned any allowlisted
  // AgentTemplate field at submit time, overlay it onto the LLM output
  // so the persisted template uses the caller's value verbatim. Lets
  // callers that have already chosen part of the template (e.g. via an
  // in-chat identity pre-pass) commit those values without depending on
  // the generator to echo them back.
  const prefill = generation.prefill as TemplatePrefill | null;
  const templateToPersist = applyPrefill(templateResult.template, prefill);
  let persisted: { id: string; slug: string };
  try {
    persisted = await persistTemplate(
      templateToPersist,
      generation.ownerAccountId,
      generation.publishStatus,
    );
  } catch (err) {
    capturePostHog({
      ...templateResult.metrics,
      ...postHogBase({ generation, requestId: generationId, inputType }),
      outcome: "failed",
    });
    throw new Error(
      `Persist stage failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. ComposeReply stage — only when twitterContext is present.
  //    composeReply has its own fallback on LLM failure, so this stage
  //    never throws; worst case we get the deterministic fallback string.
  let replyText: string | null = null;
  const twitterContext = generation.twitterContext as TwitterContext | null;
  if (twitterContext) {
    const firstSentence = firstSentenceOf(
      templateToPersist.description || templateToPersist.prompt,
    );
    // composeReply expects the canonical/hashed slug (e.g. "brewski.x4f9k")
    // — that's the form the resolver in resolve-id-or-url-slug.ts matches
    // against. `persisted.slug` is the BASE form ("brewski") because of the
    // store-base-not-hashed convention. Construct the public url slug here
    // via buildUrlSlug so the URL the reply contains
    // (`${BUILDER_SITE_URL}/a/<url-slug>`) actually resolves.
    //
    // Use `templateToPersist` (which has identity constraints applied)
    // rather than `templateResult.template` so the reply mirrors what
    // the user will actually see on the published template.
    const replyInput = {
      handle: twitterContext.twitterHandle,
      agentName: templateToPersist.agentName,
      firstSentence,
      urlSlug: buildUrlSlug(persisted.slug, persisted.id),
    };
    try {
      const reply = await composeReply(replyInput);
      replyText = reply.replyText;
    } catch (err) {
      // composeReply itself shouldn't throw — fallback is internal. Defensive log + fallback.
      logger.warn(
        { err, generationId },
        "[generation-executor] composeReply threw; using deterministic fallback",
      );
      replyText = buildDeterministicFallback(replyInput);
    }
  }

  // 6. Mark done (conditional on status='running'). If markDone returns false,
  // the pipeline lost the race against the per-generation timeout — markFailed
  // has already set status=failed. Skip the success PostHog event so metering
  // matches the row's terminal state, AND clean up the AgentTemplate we just
  // created so it doesn't surface as an orphan draft in the user's template
  // list. The template was created microseconds ago by this same execution and
  // nothing else can hold a reference yet (generation.templateId is still NULL
  // because markDone no-opped), so the delete is safe.
  const claimed = await markDone(generationId, persisted.id, replyText);
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
      ...postHogBase({ generation, requestId: generationId, inputType }),
      outcome: "failed",
    });
    return;
  }

  capturePostHog({
    ...templateResult.metrics,
    ...postHogBase({ generation, requestId: generationId, inputType }),
    outcome: "done",
  });
  logger.info(
    {
      generationId,
      templateId: persisted.id,
      slug: persisted.slug,
      hasReply: replyText !== null,
    },
    "[generation-executor] Generation complete",
  );
}

/** First-sentence helper for compose-reply's deterministic fallback. */
function firstSentenceOf(text: string | null | undefined): string {
  if (!text) return "";
  const match = text.match(/^[^.!?\n]+[.!?]?/);
  return match ? match[0].trim() : text.slice(0, 120).trim();
}
