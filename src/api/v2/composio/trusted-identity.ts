import type { Request } from "express";

/**
 * Identity headers stamped by the TRUSTED assistants worker.
 *
 * Trust model: /v2/composio is mounted behind agentApiKeyAuth, and the agent
 * API key lives exclusively in the assistants worker (Cloudflare DO) — the
 * agent container gets no key and cannot reach this surface. The worker's
 * composio.internal outbound handler builds a FRESH request to exec: it copies
 * only {toolkit, action, args} from the container and sets these headers from
 * its own state (the conversationId pinned at instance creation and the
 * instance's own inboxId), never from container input. The same key+worker
 * trust already gates the credits surface in production.
 *
 * A request bearing the key but missing these headers is fail-closed by
 * resolveTrustedCaller returning null (exec → 403): body fields or
 * container-supplied headers can never substitute, because the worker
 * overwrites them.
 */
export const CONVERSATION_ID_HEADER = "x-convos-conversation-id";
export const AGENT_INBOX_ID_HEADER = "x-convos-agent-inbox-id";

const MAX_HEADER_LENGTH = 256;

/**
 * The trusted caller of a POST /v2/composio/exec request: which agent, acting
 * in which conversation. Matched against ConnectionGrant rows — never derived
 * from the request body.
 */
export type TrustedCaller = {
  conversationId: string;
  /** The agent acting — matched against ConnectionGrant.granteeInboxId. */
  agentInboxId: string;
};

export function resolveTrustedCaller(req: Request): TrustedCaller | null {
  const conversationId = req.header(CONVERSATION_ID_HEADER)?.trim() ?? "";
  const agentInboxId = req.header(AGENT_INBOX_ID_HEADER)?.trim() ?? "";
  if (
    !conversationId ||
    !agentInboxId ||
    conversationId.length > MAX_HEADER_LENGTH ||
    agentInboxId.length > MAX_HEADER_LENGTH
  ) {
    return null;
  }
  return { conversationId, agentInboxId };
}
