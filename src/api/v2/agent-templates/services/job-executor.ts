/**
 * CreateJob background executor.
 *
 * Executes the full state machine, branching on source:
 *
 * app/web source:
 *   pending → generating → provisioning → done|failed
 *   (generate → persist draft → provision via ProvisioningClient → poll → done)
 *
 * twitter source:
 *   pending → generating → done|failed
 *   (generate → publish template → compose reply → done — no ProvisioningClient)
 *
 * Steps (app/web):
 *   1. Set status=generating, call templateGen service
 *   2. Persist generated template as draft AgentTemplate (owner=job.ownerAccountId)
 *   3. Set status=provisioning, call ProvisioningClient.createAssistant()
 *   4. Poll ProvisioningClient.getAssistant() until joinStatus ∈ {joined, failed}
 *   5. Set status=done or failed with result/error
 *   6. Set expiresAt on terminal jobs (TTL 24h)
 *
 * Steps (twitter):
 *   1. Set status=generating, call templateGen service with idea text
 *   2. Persist generated template as PUBLISHED AgentTemplate (status=published, firstPublishedAt set, version=1)
 *   3. Compose reply tweet via twitterReply service
 *   4. Set status=done with result { templateId, slug, templateUrl, replyText }
 *   5. Set expiresAt on terminal jobs (TTL 24h)
 *
 * Timeout: 5 minutes for the entire execution.
 * Fire-and-forget from POST handler: `void executeCreateJob(jobId).catch(...)`
 *
 * Test seams:
 *   - `__resetJobExecutorForTests(override)` — full executor override
 *   - `__setTimeoutMsForTests(ms|null)` — override timeout for testing
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/utils/prisma";
import { buildSlug } from "@/utils/slug-hash";
import { capturePostHog } from "./posthog";
import { ProvisioningClient } from "./provisioningClient";
import { callGenerateTemplate, type GeneratedTemplate } from "./templateGen";
import { composeReply, type ReplyInput } from "./twitterReply";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobExecutorOverride {
  executeJob?: (jobId: string) => Promise<void>;
}

/** Parsed input from the CreateJob.input JSON column (app/web source). */
interface AppWebJobInput {
  text?: string;
  pdfBase64?: string;
  imageBase64?: string;
  mimeType?: string;
  joinUrl: string;
  source?: string;
}

/** Parsed input from the CreateJob.input JSON column (twitter source). */
interface TwitterJobInput {
  source: "twitter";
  metadata: {
    idea: string;
    twitterHandle: string;
    tweetId: string;
  };
  joinUrl?: string | null;
}

/** Parsed metadata from the CreateJob.metadata JSON column (twitter source). */
interface TwitterMetadata {
  idea: string;
  twitterHandle: string;
  tweetId: string;
}

/** Result stored in CreateJob.result when status=done (app/web source). */
interface AppWebJobResult {
  templateId: string;
  provisioningInstanceId: string;
  conversationId?: string | null;
  inboxId?: string | null;
}

/** Result stored in CreateJob.result when status=done (twitter source). */
interface TwitterJobResult {
  templateId: string;
  slug: string;
  templateUrl: string;
  replyText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for terminal jobs: 24 hours in milliseconds. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Default timeout for the entire job execution: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Polling interval when waiting for provisioning joinStatus. */
const POLL_INTERVAL_MS = 2_000;

/** Default template site URL for published templates. */
const DEFAULT_TEMPLATE_SITE_URL = "https://convos.org/assistants";

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
 * Override the polling interval for provisioning status checks in tests.
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

/** Get template site URL from env. */
function getTemplateSiteUrl(): string {
  return process.env.TEMPLATE_SITE_URL || DEFAULT_TEMPLATE_SITE_URL;
}

/** Persist a generated template as a draft AgentTemplate.
 *
 *  The `id` is DB-generated via `gen_random_uuid()` (Prisma `@default(dbgenerated())`),
 *  so we create the row without an explicit `id`, then derive the stable
 *  slug hash from the DB-returned ID and patch the slug in a follow-up UPDATE.
 *  A temporary random suffix is used on the initial slug to avoid unique-constraint
 *  collisions when multiple templates share the same base name and owner.
 */
async function persistDraftTemplate(
  template: GeneratedTemplate,
  ownerAccountId: string,
): Promise<string> {
  const baseSlug = deriveBaseSlug(template.agentName);

  // Create without id — DB generates gen_random_uuid()
  const row = await prisma.agentTemplate.create({
    data: {
      slug: `${baseSlug}-tmp-${randomUUID().slice(0, 8)}`, // temporary; patched below
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

  // Derive the stable slug hash from the DB-generated ID and update
  const slug = buildSlug(baseSlug, row.id);
  await prisma.agentTemplate.update({
    where: { id: row.id },
    data: { slug },
  });

  return row.id;
}

/** Persist a generated template as a PUBLISHED AgentTemplate.
 *
 *  Same DB-generated `id` approach as persistDraftTemplate — create first,
 *  then patch the slug from the DB-returned ID. A temporary random suffix
 *  avoids unique-constraint collisions on the slug.
 */
async function persistPublishedTemplate(
  template: GeneratedTemplate,
  ownerAccountId: string,
): Promise<{ id: string; slug: string }> {
  const baseSlug = deriveBaseSlug(template.agentName);

  // Create without id — DB generates gen_random_uuid()
  const row = await prisma.agentTemplate.create({
    data: {
      slug: `${baseSlug}-tmp-${randomUUID().slice(0, 8)}`, // temporary; patched below
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
      firstPublishedAt: new Date(),
      status: "published",
      featured: false,
    },
  });

  // Derive the stable slug hash from the DB-generated ID and update
  const slug = buildSlug(baseSlug, row.id);
  await prisma.agentTemplate.update({
    where: { id: row.id },
    data: { slug },
  });

  return { id: row.id, slug };
}

// ---------------------------------------------------------------------------
// Type from ProvisioningClient
// ---------------------------------------------------------------------------

/** Inferred return type of ProvisioningClient.getAssistant(). */
type GetAssistantResult = Awaited<
  ReturnType<typeof ProvisioningClient.getAssistant>
>;

// ---------------------------------------------------------------------------
// Provisioning polling
// ---------------------------------------------------------------------------

/**
 * Poll ProvisioningClient.getAssistant() until joinStatus reaches a terminal
 * state ("joined" or "failed"), or the deadline passes.
 *
 * Returns the final GetAssistantResult, or throws on timeout.
 */
async function pollUntilTerminal(
  instanceId: string,
  deadline: number,
): Promise<GetAssistantResult> {
  while (Date.now() < deadline) {
    const result = await ProvisioningClient.getAssistant(instanceId);

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
    "Generation took too long — timed out waiting for provisioning instance",
  );
}

// ---------------------------------------------------------------------------
// Twitter executor
// ---------------------------------------------------------------------------

/**
 * Execute a twitter source job.
 *
 * State machine: pending → generating → done|failed
 * - Generates template using idea text
 * - Publishes template (not draft)
 * - Composes reply tweet
 * - Does NOT call ProvisioningClient
 */
async function executeTwitterJob(
  jobId: string,
  ownerAccountId: string,
  metadata: TwitterMetadata,
  deadline: number,
): Promise<void> {
  // ── Step 1: pending → generating ──
  await updateJob(jobId, { status: "generating" });

  // Check timeout
  if (Date.now() >= deadline) {
    await failJob(jobId, "Generation took too long — timed out");
    return;
  }

  // ── Step 2: Call templateGen with idea text ──
  const genStartTime = performance.now();
  const { template, metrics } = await callGenerateTemplate({
    text: metadata.idea,
  });

  // ── PostHog: fire builder.template.generated event with source="twitter" ──
  capturePostHog({
    ...metrics,
    source: "twitter",
    ownerAccountId,
    inputType: "idea",
    latencyMs: Math.round(performance.now() - genStartTime),
  });

  // Check timeout
  if (Date.now() >= deadline) {
    await failJob(jobId, "Generation took too long — timed out");
    return;
  }

  // ── Step 3: Persist as PUBLISHED AgentTemplate ──
  const { id: templateId, slug } = await persistPublishedTemplate(
    template,
    ownerAccountId,
  );

  // ── Step 4: Compose reply tweet ──
  const templateUrl = `${getTemplateSiteUrl()}/${slug}`;

  // Get first sentence from description or prompt for reply
  const descriptionText = template.description || template.prompt || "";
  const firstSentence =
    descriptionText.split(/[.!?]/, 1)[0]?.trim() ||
    descriptionText.slice(0, 100);

  const replyInput: ReplyInput = {
    handle: metadata.twitterHandle,
    agentName: template.agentName,
    firstSentence,
    templateUrl,
    slug,
  };

  const { replyText } = await composeReply(replyInput);

  // ── Step 5: Set status=done with twitter result ──
  const result: TwitterJobResult = {
    templateId,
    slug,
    templateUrl,
    replyText,
  };

  await prisma.createJob.update({
    where: { id: jobId },
    data: {
      status: "done",
      result: JSON.stringify(result),
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
}

// ---------------------------------------------------------------------------
// App/web executor
// ---------------------------------------------------------------------------

/**
 * Execute an app/web source job.
 *
 * State machine: pending → generating → provisioning → done|failed
 */
async function executeAppWebJob(
  jobId: string,
  ownerAccountId: string,
  input: AppWebJobInput,
  deadline: number,
): Promise<void> {
  // Determine input type for PostHog metering
  const inputType: string = input.pdfBase64
    ? "pdfBase64"
    : input.imageBase64
      ? "imageBase64"
      : "text";

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
    ownerAccountId,
    inputType,
    latencyMs: Math.round(performance.now() - genStartTime),
  });

  // Check timeout
  if (Date.now() >= deadline) {
    await failJob(jobId, "Generation took too long — timed out");
    return;
  }

  // ── Step 3: Persist as draft AgentTemplate ──
  const templateId = await persistDraftTemplate(template, ownerAccountId);

  // ── Step 4: generating → provisioning ──
  const partialResult: AppWebJobResult = {
    templateId,
    provisioningInstanceId: "",
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

  // ── Step 5: Call ProvisioningClient.createAssistant ──
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

  const { instanceId } = await ProvisioningClient.createAssistant(createOpts);

  // ── Step 6: Poll until terminal ──
  const finalStatus = await pollUntilTerminal(instanceId, deadline);

  // ── Step 7: Transition to done or failed ──
  if (finalStatus.joinStatus === "joined") {
    const result: AppWebJobResult = {
      templateId,
      provisioningInstanceId: instanceId,
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
      finalStatus.joinFailureReason || "Provisioning instance failed to join";
    await failJob(jobId, errorMsg);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a create-job asynchronously.
 *
 * Branches on source:
 *   - app/web: pending → generating → provisioning → done|failed
 *   - twitter: pending → generating → done|failed
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

  // Determine source from the job's source column
  const source: string = job.source;

  // Parse metadata for twitter source
  let twitterMetadata: TwitterMetadata | null = null;
  if (source === "twitter" && job.metadata) {
    try {
      twitterMetadata = JSON.parse(job.metadata) as TwitterMetadata;
    } catch {
      await failJob(jobId, "Invalid job metadata — could not parse JSON");
      return;
    }
  }

  // Parse input
  let input: AppWebJobInput | TwitterJobInput;
  try {
    input = JSON.parse(job.input) as AppWebJobInput | TwitterJobInput;
  } catch {
    await failJob(jobId, "Invalid job input — could not parse JSON");
    return;
  }

  const timeoutMs = _timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  try {
    // Branch on source
    if (source === "twitter") {
      if (!twitterMetadata) {
        await failJob(
          jobId,
          "Twitter source job missing metadata (idea, twitterHandle, tweetId)",
        );
        return;
      }
      await executeTwitterJob(
        jobId,
        job.ownerAccountId,
        twitterMetadata,
        deadline,
      );
    } else {
      // app/web source
      await executeAppWebJob(
        jobId,
        job.ownerAccountId,
        input as AppWebJobInput,
        deadline,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // If we're in generating, the failure is from templateGen
    // If we're in provisioning, the failure is from the provisioning service
    // The error message is descriptive enough on its own
    await failJob(jobId, message);
  }
}
