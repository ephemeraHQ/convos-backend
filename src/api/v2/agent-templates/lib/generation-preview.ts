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

/** The draft agent surfaced as `preview` on in-progress poll responses — the
 *  provisional identity card shown while the build runs. Only the identity is
 *  ever populated; the full agent arrives via the real template (`templateId`)
 *  on the terminal 200. */
export interface AgentPreview {
  agentName?: string;
  emoji?: string;
  description?: string;
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
    out.preview = preview;
  }
  if (Array.isArray(progressPhrases) && progressPhrases.length > 0) {
    out.progressPhrases = progressPhrases as string[];
  }
  return out;
}
