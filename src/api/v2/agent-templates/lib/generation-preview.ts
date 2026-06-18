/**
 * Shared shape + serializer for the in-progress poll fields, used by both poll
 * handlers (generations-get, generations-post) so the wire contract stays
 * identical between them.
 *
 * The distill stage writes two columns while the build runs:
 *   - `preview`         — the draft agent identity { agentName, emoji, description }
 *   - `progressPhrases` — the build-narration array
 * Both are surfaced as top-level response fields on the in-progress (202)
 * responses and omitted from the terminal 200 (which hands back `templateId`
 * instead — the client fetches the real template for the full fields). Callers
 * gate `previewResponseFields` on non-terminal status.
 */

import {
  GENERATION_ESTIMATE_MS,
  GENERATION_ESTIMATE_WITH_ATTACHMENTS_MS,
} from "@/config";

/** The draft agent surfaced as `preview` on in-progress poll responses — the
 *  provisional identity card shown while the build runs. Only the identity is
 *  ever populated; the full agent arrives via the real template (`templateId`)
 *  on the terminal 200. */
export interface AgentPreview {
  agentName?: string;
  emoji?: string;
  description?: string;
}

/** True when the generation's `inputs` carry at least one binary attachment.
 *  Reads the raw JSON column (typed `unknown` at the Prisma boundary). */
function hasAttachments(inputs: unknown): boolean {
  if (!inputs || typeof inputs !== "object") return false;
  const attachments = (inputs as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

/** Rough estimate (ms) of how long this build will take, surfaced as
 *  `estimatedDurationMs` on the in-progress (202) responses so a client can
 *  size its progress indicator. Attachments raise the estimate (fetch +
 *  moderation + multimodal overhead). Both values are env-tunable. Call only
 *  for non-terminal rows — the terminal 200 carries no estimate. */
export function estimatedDurationMs(inputs: unknown): number {
  return hasAttachments(inputs)
    ? GENERATION_ESTIMATE_WITH_ATTACHMENTS_MS
    : GENERATION_ESTIMATE_MS;
}

/**
 * Narrow a row's raw `preview` / `progressPhrases` columns (typed `unknown` at
 * the Prisma boundary) into the response-facing fields, omitting anything
 * absent. Call only for non-terminal rows — the terminal 200 carries neither.
 */
export function previewResponseFields(
  preview: unknown,
  progressPhrases: unknown,
): { preview?: AgentPreview; progressPhrases?: string[] } {
  const out: { preview?: AgentPreview; progressPhrases?: string[] } = {};
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    const p = preview as Record<string, unknown>;
    const shaped: AgentPreview = {};
    if (typeof p.agentName === "string") shaped.agentName = p.agentName;
    if (typeof p.emoji === "string") shaped.emoji = p.emoji;
    if (typeof p.description === "string") shaped.description = p.description;
    if (Object.keys(shaped).length > 0) out.preview = shaped;
  }
  if (Array.isArray(progressPhrases)) {
    const phrases = progressPhrases.filter(
      (phrase): phrase is string =>
        typeof phrase === "string" && phrase.trim().length > 0,
    );
    if (phrases.length > 0) out.progressPhrases = phrases;
  }
  return out;
}
