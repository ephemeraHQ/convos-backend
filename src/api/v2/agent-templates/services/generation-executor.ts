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

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { capturePostHog } from "@/api/v2/agent-templates/services/posthog";
import {
  callGenerateTemplate,
  getModel,
  type GenerateTemplateInput,
} from "@/api/v2/agent-templates/services/templateGen";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { buildSlug } from "@/utils/slug-hash";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for terminal generations: 24 hours by default, env-configurable. */
const DEFAULT_TTL_HOURS = 24;

/** Default timeout for entire generation: 5 minutes. */
const DEFAULT_EXECUTOR_TIMEOUT_MS = 5 * 60 * 1000;

function getTtlMs(): number {
  const raw = process.env.GENERATION_TTL_HOURS;
  const hours = raw ? Number.parseInt(raw, 10) : DEFAULT_TTL_HOURS;
  if (!Number.isFinite(hours) || hours <= 0)
    return DEFAULT_TTL_HOURS * 3600 * 1000;
  return hours * 3600 * 1000;
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
 * Pass `null` to restore the default.
 */
export function __setExecutorTimeoutMsForTests(ms: number | null): void {
  _timeoutMsOverride = ms;
}

function getTimeoutMs(): number {
  if (_timeoutMsOverride !== null) return _timeoutMsOverride;
  const raw = process.env.GENERATION_STUCK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_EXECUTOR_TIMEOUT_MS;
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
): Promise<{ id: string; slug: string }> {
  const baseSlug = deriveBaseSlug(template.agentName);
  const id = randomUUID();
  const slug = buildSlug(baseSlug, id);

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
      firstPublishedAt: null,
      status: "draft",
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

async function markDone(
  generationId: string,
  templateId: string,
): Promise<void> {
  await prisma.agentTemplateGeneration.update({
    where: { id: generationId },
    data: {
      status: "done",
      templateId,
      expiresAt: new Date(Date.now() + getTtlMs()),
    },
  });
}

async function markFailed(generationId: string, error: string): Promise<void> {
  try {
    await prisma.agentTemplateGeneration.update({
      where: { id: generationId },
      data: {
        status: "failed",
        error,
        expiresAt: new Date(Date.now() + getTtlMs()),
      },
    });
  } catch (err) {
    // Row gone, or already marked terminal elsewhere — swallow.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return;
    }
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

  // 2. Race against the per-generation timeout
  const timeoutMs = getTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([_runPipeline(generationId), timeout]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, generationId }, "[generation-executor] Pipeline failed");
    await markFailed(generationId, message);
  } finally {
    clearTimeout(timer);
  }
}

async function _runPipeline(generationId: string): Promise<void> {
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
    templateResult = await callGenerateTemplate(coalesced);
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
  let persisted: { id: string; slug: string };
  try {
    persisted = await persistTemplate(
      templateResult.template,
      generation.ownerAccountId,
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

  // 5. Mark done + meter success
  await markDone(generationId, persisted.id);
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
