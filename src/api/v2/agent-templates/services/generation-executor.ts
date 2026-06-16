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

import type { Prisma } from "@prisma/client";
import type { AgentPreview } from "@/api/v2/agent-templates/lib/generation-preview";
import { pickCollisionFreeId } from "@/api/v2/agent-templates/lib/pick-collision-free-id";
import {
  applyConnections,
  resolveConnectionIds,
} from "@/api/v2/agent-templates/lib/template-connections";
import {
  AttachmentModerationError,
  resolveAttachments,
  type AttachmentRef,
  type ResolvedInputs,
} from "@/api/v2/agent-templates/services/attachment-resolver";
import { classifyMime } from "@/api/v2/agent-templates/services/build-attachments";
import {
  buildDeterministicFallback,
  composeReply,
} from "@/api/v2/agent-templates/services/compose-reply";
import { distill } from "@/api/v2/agent-templates/services/distill";
import { type TraceContext } from "@/api/v2/agent-templates/services/openrouter-client";
import {
  capturePostHog,
  resolveActor,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";
import { revalidateTemplate } from "@/api/v2/agent-templates/services/revalidate-dashboard";
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
import { buildUrlSlug } from "@/utils/url-slug";

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
  /** Presigned-upload references to the binary attachments (image / PDF /
   *  voice). Validated at submit; resolved to bytes here. */
  attachments?: AttachmentRef[];
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

/** First trimmed, non-empty value of (a, b), else undefined. Used to merge the
 *  distilled identity with the caller's pins (caller wins) while dropping the
 *  empties distill can return (e.g. an emoji the sanitizer rejected) so they
 *  don't overlay a blank over the generator's own value. */
function firstNonEmpty(a?: string, b?: string): string | undefined {
  const v = (a ?? "").trim() || (b ?? "").trim();
  return v || undefined;
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
  inputType: "text" | "image" | "pdf" | "audio" | "mixed";
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
// Input modality summary — for PostHog metering
// ---------------------------------------------------------------------------

/** Collapse the submitted inputs into one modality tag. Attachments win over an
 *  accompanying text directive (which is auxiliary intent, not the source
 *  material), matching the pre-attachment behaviour where a file's type was the
 *  classification. A single attachment kind reports that kind; multiple distinct
 *  kinds (e.g. image + pdf) report "mixed"; no attachments report "text". Audio
 *  counts as "audio" even though its transcript folds into text downstream — the
 *  metric reflects what the caller sent, not how it was processed. */
function summarizeInputType(
  textInput: string | undefined,
  attachments: AttachmentRef[],
): "text" | "image" | "pdf" | "audio" | "mixed" {
  if (attachments.length === 0) return "text";
  const kinds = new Set<string>();
  for (const a of attachments) {
    const kind = classifyMime(a.mimeType);
    if (kind) kinds.add(kind);
  }
  if (kinds.size === 0) return "text";
  if (kinds.size === 1) {
    return [...kinds][0] as "image" | "pdf" | "audio";
  }
  return "mixed";
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
 *    `hashId(id)` doesn't collide with any existing row sharing `baseSlug`,
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

/** Write the in-progress poll fields (the distilled identity `preview` + the
 *  `progressPhrases`) while the build runs, so the poll endpoints can surface
 *  them on 202s. Both land in one update. Guarded on status='running' like the
 *  terminal writes: the stuck-row sweep may have flipped the row to failed
 *  between claim and here, in which case the 0-row update is a harmless no-op.
 *  Best-effort — never throws into the pipeline (callers wrap it). The handlers
 *  drop both fields on the terminal 200, so markDone leaves them untouched. */
async function writeRunningPreview(
  generationId: string,
  preview: AgentPreview,
  progressPhrases: string[],
): Promise<void> {
  await prisma.agentTemplateGeneration.updateMany({
    where: { id: generationId, status: "running" },
    data: {
      preview: preview as unknown as Prisma.InputJsonValue,
      progressPhrases,
    },
  });
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

  // 3. Resolve inputs — the user's text directive + any attachment references.
  const inputs = generation.inputs as GenerationInputs;
  const textInput = [inputs.text, inputs.idea, inputs.content, inputs.url].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const attachmentRefs = inputs.attachments ?? [];
  if (!textInput && attachmentRefs.length === 0) {
    throw new Error(
      "No usable input — provide text or at least one attachment",
    );
  }

  // Input modality summary for metering, derived from what the caller sent.
  const inputType = summarizeInputType(textInput, attachmentRefs);

  // Caller-pinned prefill is read up front so it can be fed INTO the generator
  // (so the produced prompt + welcome use the pinned name), not just overlaid
  // onto the metadata at persist below.
  const prefill = generation.prefill as TemplatePrefill | null;

  // Twitter context, read up front: the distill stage below skips the twitter
  // path (no client polls a progress card there), and the ComposeReply stage
  // further down consumes it.
  const twitterContext = generation.twitterContext as TwitterContext | null;

  // Optional caller-supplied builder/system prompt override (admin dashboard).
  // null for ordinary generations, where the canonical prompt is used.
  const builderPrompt = generation.builderPrompt;

  // Optional caller-supplied model override (admin dashboard). null for
  // ordinary generations, where the default builder model is used.
  const builderModel = generation.builderModel;

  // Connections the caller flagged at submit, normalized to canonical catalog
  // ids. Fed to the generator (drives the capabilities directive so the prompt +
  // welcome lean on the service) and overlaid onto the persisted template below.
  const connectionIds = resolveConnectionIds(generation.connections);

  // Actor-attribution fields shared by every capture site below, plus the
  // PostHog LLM Analytics trace id so the product event joins to the
  // `$ai_generation` spans the OpenRouter calls emit. Built once: the trace's
  // distinctId reuses the same actor ladder as the product event, so traces
  // and events attribute to one PostHog person.
  const base = {
    ...postHogBase({ generation, requestId: generationId, inputType }),
    aiTraceId: generationId,
  };
  const actor = resolveActor(base);
  const trace: TraceContext = {
    traceId: generationId,
    distinctId: actor.distinctId,
    properties: {
      generation_id: generationId,
      source: generation.source,
      input_type: inputType,
      actor_kind: actor.kind,
    },
  };

  // 3a. Resolve attachments off the request path: fetch bytes from the private
  // bucket, moderate images (Rekognition) + transcribe/moderate audio, and
  // build the image/PDF content blocks. A failure here — unfetchable, oversize,
  // unsupported, or moderation-blocked — fails the generation. For binary that
  // surfaces as a terminal `failed` (not a submit-time 422): Rekognition over N
  // images and audio transcription are too slow to gate the POST synchronously.
  let resolved: ResolvedInputs;
  try {
    resolved = await resolveAttachments(attachmentRefs, {
      signal,
      trace,
      moderate: true,
    });
  } catch (err) {
    capturePostHog({
      model: getModel(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      ...base,
      outcome: "failed",
    });
    throw new Error(
      err instanceof AttachmentModerationError
        ? `Attachment moderation blocked: ${err.reason}`
        : `Attachment stage failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
    );
  }

  // Voice transcripts are user text — fold them into the directive so distill
  // and the text path see them, leaving the generator to handle only the
  // image/PDF blocks.
  const effectiveText =
    [textInput, ...resolved.transcripts]
      .filter((t): t is string => !!t && t.trim().length > 0)
      .join("\n\n") || undefined;
  if (!effectiveText && resolved.attachments.length === 0) {
    throw new Error("No usable input after resolving attachments");
  }
  const generateInput: GenerateTemplateInput = {
    ...(effectiveText ? { text: effectiveText } : {}),
    ...(resolved.attachments.length
      ? { attachments: resolved.attachments }
      : {}),
  };

  // 3b. Distill stage (best-effort). Derive the agent's identity + the
  // build-narration progressPhrases up front and write them to the row so the
  // poll endpoints surface a `preview` card + `progressPhrases` on the early
  // 202s, before the slow generate stage finishes. Runs whenever there's
  // something to distill from — text and/or image/PDF attachments (the
  // vision-capable builder model distills a bare image/PDF straight from the
  // files); only the twitter path is skipped, since nothing polls a progress
  // card there. A failure here never fails the generation: the build still
  // produces the full template; the 202s just won't carry phrases / a card. The
  // distilled identity (caller pins win) also feeds the generate + persist
  // below, so the final template matches the card shown on the early polls.
  const distillText = effectiveText?.trim();
  let identity: TemplatePrefill | null = prefill;
  if ((distillText || resolved.attachments.length > 0) && !twitterContext) {
    try {
      const distilled = await distill(
        { text: distillText, attachments: resolved.attachments },
        signal,
        prefill,
        trace,
      );
      identity = {
        agentName: firstNonEmpty(prefill?.agentName, distilled.agentName),
        emoji: firstNonEmpty(prefill?.emoji, distilled.emoji),
        description: firstNonEmpty(prefill?.description, distilled.description),
      };
      await writeRunningPreview(
        generationId,
        identity,
        distilled.progressPhrases,
      );
    } catch (err) {
      logger.warn(
        { err, generationId },
        "[generation-executor] Distill stage failed; proceeding without preview",
      );
    }
  }

  const startTime = performance.now();
  let templateResult: Awaited<ReturnType<typeof callGenerateTemplate>>;
  try {
    templateResult = await callGenerateTemplate(
      generateInput,
      signal,
      identity,
      trace,
      builderPrompt,
      builderModel,
      connectionIds,
    );
  } catch (err) {
    // Meter error path
    capturePostHog({
      model: getModel(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Math.round(performance.now() - startTime),
      ...base,
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
  // Overlay the allowlisted identity fields onto the LLM output so the persisted
  // metadata matches the card shown on the early polls verbatim. `identity`
  // is the distilled identity (or the caller's pins where supplied) — the same
  // value fed into the generator above, so the prompt body agrees with the
  // metadata. Then overlay the resolved connections, replacing the generator's
  // hardcoded `connections: []` so the template records the services it uses.
  const templateToPersist = applyConnections(
    applyPrefill(templateResult.template, identity),
    connectionIds,
  );
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
      ...base,
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
      const reply = await composeReply(replyInput, trace);
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
  //
  // The terminal 200 carries `templateId` (the client fetches the real template
  // for the full fields), not `preview`/`progressPhrases` — so markDone leaves
  // those running columns untouched; the handlers simply omit them once terminal.
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
      ...base,
      outcome: "failed",
    });
    return;
  }

  capturePostHog({
    ...templateResult.metrics,
    ...base,
    outcome: "done",
  });

  // Only fire revalidation when the new row is actually visible on the
  // dashboard. Drafts aren't surfaced, so the cache has nothing to drop.
  if (generation.publishStatus !== "draft") {
    void revalidateTemplate({ id: persisted.id, slug: persisted.slug });
  }

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
