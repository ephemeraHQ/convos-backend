/**
 * CreateJob background executor.
 *
 * Executes the full state machine:
 *   pending → generating → provisioning → done|failed
 *
 * Steps:
 *   1. Set status=generating, call templateGen service
 *   2. Persist generated template as draft AgentTemplate (owner=ADMIN_ACCOUNT_ID)
 *   3. Set status=provisioning, call PlaygroundClient.createAssistant()
 *   4. Poll PlaygroundClient.getAssistant() until joinStatus ∈ {joined, failed}
 *   5. Set status=done or failed with result/error
 *   6. Set expiresAt on terminal jobs (TTL 24h)
 *
 * Timeout: 5 minutes for the entire execution.
 * Fire-and-forget from POST handler: `void executeCreateJob(jobId).catch(...)`
 *
 * Test seams:
 *   - `__resetJobExecutorForTests(override)` — full executor override
 *   - `__setTimeoutMsForTests(ms|null)` — override timeout for testing
 */

import { ADMIN_ACCOUNT_ID, mintTemplateId } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";
import { buildSlug } from "@/utils/slug-hash";
import { PlaygroundClient } from "./playgroundClient";
import { capturePostHog } from "./posthog";
import { callGenerateTemplate, type GeneratedTemplate } from "./templateGen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobExecutorOverride {
  executeJob?: (jobId: string) => Promise<void>;
}

/** Parsed input from the CreateJob.input JSON column. */
interface JobInput {
  text?: string;
  pdfBase64?: string;
  imageBase64?: string;
  mimeType?: string;
  joinUrl: string;
}

/** Result stored in CreateJob.result when status=done. */
interface JobResult {
  templateId: string;
  playgroundInstanceId: string;
  conversationId?: string | null;
  inboxId?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for terminal jobs: 24 hours in milliseconds. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Default timeout for the entire job execution: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Polling interval when waiting for playground joinStatus. */
const POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

let _override: JobExecutorOverride | null = null;
let _timeoutMs: number | null = null;
let _pollIntervalMs: number | null = null;

/**
 * Install a test override for the job executor.
 * Pass `null` to restore normal behaviour.
 */
export function __resetJobExecutorForTests(
  override: JobExecutorOverride | null,
): void {
  _override = override;
}

/**
 * Override the timeout for job execution in tests.
 * Pass `null` to restore the default 5-minute timeout.
 */
export function __setTimeoutMsForTests(ms: number | null): void {
  _timeoutMs = ms;
}

/**
 * Override the polling interval for playground status checks in tests.
 * Pass `null` to restore the default 2-second interval.
 */
export function __setPollIntervalMsForTests(ms: number | null): void {
  _pollIntervalMs = ms;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Update job status and optionally set result/error/expiresAt. */
async function updateJob(
  jobId: string,
  data: {
    status: string;
    result?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const updateData: Record<string, unknown> = {
    status: data.status,
  };

  if (data.result !== undefined) {
    updateData.result = data.result;
  }
  if (data.error !== undefined) {
    updateData.error = data.error;
  }

  await prisma.createJob.update({
    where: { id: jobId },
    data: updateData,
  });
}

/** Set expiresAt on a terminal job. */
async function setExpiresAt(jobId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  await prisma.createJob.update({
    where: { id: jobId },
    data: { expiresAt },
  });
}

/** Mark a job as failed with an error message and set expiresAt. */
async function failJob(jobId: string, errorMessage: string): Promise<void> {
  await prisma.createJob.update({
    where: { id: jobId },
    data: {
      status: "failed",
      error: errorMessage,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
}

// ---------------------------------------------------------------------------
// Template persistence
// ---------------------------------------------------------------------------

/** Derive a slug-safe base from an agent name. */
function deriveBaseSlug(agentName: string): string {
  return agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Persist a generated template as a draft AgentTemplate. */
async function persistDraftTemplate(
  template: GeneratedTemplate,
): Promise<string> {
  const id = mintTemplateId();
  const baseSlug = deriveBaseSlug(template.agentName);
  const slug = buildSlug(baseSlug, id);

  await prisma.agentTemplate.create({
    data: {
      id,
      slug,
      ownerAccountId: ADMIN_ACCOUNT_ID,
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

  return id;
}

// ---------------------------------------------------------------------------
// Type from PlaygroundClient
// ---------------------------------------------------------------------------

/** Inferred return type of PlaygroundClient.getAssistant(). */
type GetAssistantResult = Awaited<
  ReturnType<typeof PlaygroundClient.getAssistant>
>;

// ---------------------------------------------------------------------------
// Playground polling
// ---------------------------------------------------------------------------

/**
 * Poll PlaygroundClient.getAssistant() until joinStatus reaches a terminal
 * state ("joined" or "failed"), or the deadline passes.
 *
 * Returns the final GetAssistantResult, or throws on timeout.
 */
async function pollUntilTerminal(
  instanceId: string,
  deadline: number,
): Promise<GetAssistantResult> {
  while (Date.now() < deadline) {
    const result = await PlaygroundClient.getAssistant(instanceId);

    if (result.joinStatus === "joined" || result.joinStatus === "failed") {
      return result;
    }

    // Wait before next poll, but don't exceed the deadline
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const interval = _pollIntervalMs ?? POLL_INTERVAL_MS;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(interval, remaining)),
    );
  }

  throw new Error(
    "Generation took too long — timed out waiting for playground instance",
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a create-job asynchronously.
 *
 * State machine: pending → generating → provisioning → done|failed
 *
 * The POST handler calls this as fire-and-forget:
 * `void executeCreateJob(jobId).catch(...)`
 */
export async function executeCreateJob(jobId: string): Promise<void> {
  // Test seam: delegate to override if installed
  if (_override?.executeJob) {
    return _override.executeJob(jobId);
  }

  // 1. Fetch the job
  const job = await prisma.createJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  // Skip if already terminal
  if (job.status === "done" || job.status === "failed") {
    // Ensure expiresAt is set (handles pre-existing terminal jobs)
    if (job.expiresAt === null) {
      await setExpiresAt(jobId);
    }
    return;
  }

  // Parse input
  let input: JobInput;
  try {
    input = JSON.parse(job.input) as JobInput;
  } catch {
    await failJob(jobId, "Invalid job input — could not parse JSON");
    return;
  }

  const timeoutMs = _timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // Determine input type for PostHog metering
  const inputType: string = input.pdfBase64
    ? "pdfBase64"
    : input.imageBase64
      ? "imageBase64"
      : "text";

  try {
    // ── Step 1: pending → generating ──
    await updateJob(jobId, { status: "generating" });

    // Check timeout
    if (Date.now() >= deadline) {
      await failJob(jobId, "Generation took too long — timed out");
      return;
    }

    // ── Step 2: Call templateGen ──
    const templateInput: Record<string, string | undefined> = {};
    if (input.text) templateInput.text = input.text;
    if (input.pdfBase64) templateInput.pdfBase64 = input.pdfBase64;
    if (input.imageBase64) templateInput.imageBase64 = input.imageBase64;
    if (input.mimeType) templateInput.mimeType = input.mimeType;

    const genStartTime = performance.now();
    const { template, metrics } = await callGenerateTemplate(templateInput);

    // ── PostHog: fire builder.template.generated event on successful generation ──
    // This fires BEFORE provisioning, so it captures generation success even if
    // provisioning later fails. The event is NOT fired when generation fails
    // (that path goes to the catch block which calls failJob without PostHog).
    capturePostHog({
      ...metrics,
      source: "create-job",
      ownerAccountId: job.ownerAccountId,
      inputType,
      latencyMs: Math.round(performance.now() - genStartTime),
    });

    // Check timeout
    if (Date.now() >= deadline) {
      await failJob(jobId, "Generation took too long — timed out");
      return;
    }

    // ── Step 3: Persist as draft AgentTemplate ──
    const templateId = await persistDraftTemplate(template);

    // ── Step 4: generating → provisioning ──
    const partialResult: JobResult = {
      templateId,
      playgroundInstanceId: "",
    };

    await updateJob(jobId, {
      status: "provisioning",
      result: JSON.stringify(partialResult),
    });

    // Check timeout
    if (Date.now() >= deadline) {
      await failJob(jobId, "Generation took too long — timed out");
      return;
    }

    // ── Step 5: Call PlaygroundClient.createAssistant ──
    const createOpts: {
      name: string;
      instructions: string;
      joinUrl: string;
      metadata?: Record<string, unknown>;
    } = {
      name: template.agentName,
      instructions: template.prompt,
      joinUrl: input.joinUrl,
      metadata: { source: "create-job" },
    };

    const { instanceId } = await PlaygroundClient.createAssistant(createOpts);

    // ── Step 6: Poll until terminal ──
    const finalStatus = await pollUntilTerminal(instanceId, deadline);

    // ── Step 7: Transition to done or failed ──
    if (finalStatus.joinStatus === "joined") {
      const result: JobResult = {
        templateId,
        playgroundInstanceId: instanceId,
        conversationId: finalStatus.conversationId ?? null,
        inboxId: finalStatus.inboxId ?? null,
      };

      await prisma.createJob.update({
        where: { id: jobId },
        data: {
          status: "done",
          result: JSON.stringify(result),
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
    } else {
      // joinStatus === "failed"
      const errorMsg =
        finalStatus.joinFailureReason || "Playground instance failed to join";
      await failJob(jobId, errorMsg);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // If we're in generating, the failure is from templateGen
    // If we're in provisioning, the failure is from playground
    // The error message is descriptive enough on its own
    await failJob(jobId, message);
  }
}
