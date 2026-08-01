import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAssistantApiKey,
  getAssistantApiUrl,
} from "@/api/v2/agents/handlers/assistant-config";
import { resolveVariantWorkerOrigin } from "@/api/v2/agents/lib/variant-routing";
import { XMTP_ENV } from "@/config";

const PARTICIPATION_FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_LOG_LIMIT = 200;

const paramsSchema = z.object({
  conversationId: z
    .string()
    .trim()
    .min(1, "conversationId is required")
    .max(256),
});

export const bodySchema = z
  .object({
    mode: z.enum(["speak", "mention", "paused"]),
  })
  .strict();

const upstreamReadSchema = z.object({
  mode: z.enum(["speak", "mention", "paused"]),
});

const querySchema = z.object({
  variantId: z.string().trim().min(1).max(64).optional(),
});

const ERRORS = {
  UPDATE_FAILED: {
    status: 502,
    error: "PARTICIPATION_UPDATE_FAILED",
    message: "Failed to update agent participation",
  },
  READ_FAILED: {
    status: 502,
    error: "PARTICIPATION_READ_FAILED",
    message: "Failed to read agent participation",
  },
  ASSISTANT_UNAVAILABLE: {
    status: 503,
    error: "AGENT_POOL_UNAVAILABLE",
    message: "Assistant API is not configured",
  },
  ASSISTANT_TIMEOUT: {
    status: 504,
    error: "AGENT_POOL_TIMEOUT",
    message: "Assistant participation request timed out",
  },
} as const;

/**
 * Resolves where the control plane lives and how to authenticate to it.
 *
 * Shared by the read and the write so they can never disagree about which
 * worker holds the level — a read answered by the default worker while the
 * write went to a variant would show the user a level that isn't theirs.
 */
async function resolveAssistantTarget(
  req: Request,
): Promise<AssistantTarget | null> {
  const assistantApiUrl = getAssistantApiUrl();
  if (!assistantApiUrl) return null;

  // Dev-only variant routing, same as the join poller: an assistant
  // provisioned on a variant worker does not exist on the default one.
  const defaultBaseUrl = assistantApiUrl.replace(/\/+$/, "");
  let baseUrl = defaultBaseUrl;
  const variantId = querySchema.safeParse(req.query).data?.variantId;
  if (variantId && XMTP_ENV !== "production") {
    const origin = await resolveVariantWorkerOrigin(variantId);
    if (origin) baseUrl = origin;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const assistantApiKey = getAssistantApiKey();
  if (assistantApiKey) {
    headers.Authorization = `Bearer ${assistantApiKey}`;
  }
  return { baseUrl, defaultBaseUrl, headers };
}

export type AssistantTarget = {
  baseUrl: string;
  defaultBaseUrl: string;
  headers: Record<string, string>;
};

/**
 * A variant answer that means "this worker cannot serve this conversation",
 * as opposed to a real upstream failure worth reporting.
 *
 * 404 is a variant deployed from a branch that predates the participation
 * route. 401/403 is a variant whose worker holds a different key than the one
 * we authenticate with — its secret set can legitimately diverge from the
 * default worker's. Neither says anything about the conversation, and both are
 * answerable by the default worker.
 */
const VARIANT_UNUSABLE_STATUSES = new Set([401, 403, 404]);

/**
 * Send a participation request, falling back to the default worker when the
 * pinned variant cannot answer it.
 *
 * A device keeps sending the variant it has selected in the debug menu long
 * after that variant's worker is gone — the registry row outlives the
 * deployment, so `resolveVariantWorkerOrigin` still hands back an origin whose
 * hostname no longer resolves. Without this, every participation call from that
 * device fails: the write surfaces "Participation not updated" and the read
 * fails silently, leaving the control on a level the conversation is not in.
 *
 * The variant is a routing preference, never a correctness requirement — the
 * conversation's level lives on the default control plane either way — so an
 * unreachable variant degrades to the default worker instead of failing the
 * member's request. A failure from the default worker is reported as-is.
 */
export async function fetchParticipation(
  req: Pick<Request, "log">,
  target: AssistantTarget,
  conversationId: string,
  init: RequestInit,
  // `Response` in this file is express's; this one is the fetch response.
): Promise<globalThis.Response> {
  const request = (baseUrl: string) =>
    fetch(upstreamUrl(baseUrl, conversationId), {
      ...init,
      headers: target.headers,
      signal: AbortSignal.timeout(PARTICIPATION_FETCH_TIMEOUT_MS),
    });

  const onVariant = target.baseUrl !== target.defaultBaseUrl;
  if (!onVariant) return request(target.defaultBaseUrl);

  let response: globalThis.Response;
  try {
    response = await request(target.baseUrl);
  } catch (error) {
    // A timeout is a live-but-slow worker and stays the caller's problem; any
    // other transport error (DNS, refused, reset) means the variant is simply
    // not there.
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw error;
    req.log.warn(
      { variantOrigin: target.baseUrl },
      "Variant worker unreachable; falling back to the default assistant worker",
    );
    return request(target.defaultBaseUrl);
  }

  if (VARIANT_UNUSABLE_STATUSES.has(response.status)) {
    // Hand the socket back before opening the second one. Dropping a response
    // without reading it leaves undici holding the connection until GC gets to
    // it, and every call from a device pinned to a dead variant takes this
    // path, so the leak would compound. A cancel on an already-errored body is
    // not worth surfacing: the response is being discarded either way.
    await response.body?.cancel().catch(() => {});
    req.log.warn(
      { variantOrigin: target.baseUrl, status: response.status },
      "Variant worker cannot serve participation; falling back to the default assistant worker",
    );
    return request(target.defaultBaseUrl);
  }
  return response;
}

function upstreamUrl(baseUrl: string, conversationId: string): string {
  return `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/participation`;
}

/**
 * Handlers for /api/v2/conversations/:conversationId/participation
 *
 * How much the agents in a conversation may speak: "speak" (normal), "mention"
 * (only when addressed) or "paused" (they do not run at all). The level belongs
 * to the conversation, so a room with several agents has one setting that
 * governs all of them, and an agent that joins later inherits it.
 *
 * These exist because the app cannot call the control plane directly. That
 * route is guarded by the shared assistant API key, which must not ship inside
 * a client, so the app authenticates to us and we hold the key. Paused in
 * particular depends on this hop: the level has to be recorded upstream before
 * a message arrives, otherwise the agent is still woken and still billed for a
 * turn it will discard.
 *
 * Authorization is "any authenticated account". The product rule is that any
 * member of the conversation may change the level, and membership lives in the
 * XMTP group, which this service cannot read. An owner-only check would be the
 * wrong rule rather than a stricter one.
 */
export async function getParticipationHandler(req: Request, res: Response) {
  const target = await resolveAssistantTarget(req);
  if (!target) {
    req.log.error("Assistant API not configured");
    const { status, ...body } = ERRORS.ASSISTANT_UNAVAILABLE;
    res.status(status).json({ success: false, ...body });
    return;
  }

  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsedParams.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { conversationId } = parsedParams.data;

  try {
    const upstream = await fetchParticipation(req, target, conversationId, {
      method: "GET",
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      req.log.error(
        {
          status: upstream.status,
          bodyPreview: text.substring(0, ERROR_BODY_LOG_LIMIT),
        },
        "Assistant participation read failed",
      );
      const { status, ...body } = ERRORS.READ_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const parsedUpstream = upstreamReadSchema.safeParse(await upstream.json());
    if (!parsedUpstream.success) {
      req.log.error("Assistant participation read returned an unknown level");
      const { status, ...body } = ERRORS.READ_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    res.status(200).json({
      success: true,
      conversationId,
      mode: parsedUpstream.data.mode,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Assistant participation read timed out");
      const { status, ...body } = ERRORS.ASSISTANT_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Assistant participation read failed",
    );
    const { status, ...body } = ERRORS.READ_FAILED;
    res.status(status).json({ success: false, ...body });
  }
}

export async function participationHandler(req: Request, res: Response) {
  const target = await resolveAssistantTarget(req);
  if (!target) {
    req.log.error("Assistant API not configured");
    const { status, ...body } = ERRORS.ASSISTANT_UNAVAILABLE;
    res.status(status).json({ success: false, ...body });
    return;
  }

  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsedParams.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsedBody.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { conversationId } = parsedParams.data;
  const { mode } = parsedBody.data;

  try {
    const upstream = await fetchParticipation(req, target, conversationId, {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      req.log.error(
        {
          status: upstream.status,
          bodyPreview: text.substring(0, ERROR_BODY_LOG_LIMIT),
        },
        "Assistant participation update failed",
      );
      const { status, ...body } = ERRORS.UPDATE_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    // Echo what was applied rather than the upstream body: the client needs to
    // render the level it just set, and nothing else upstream returns is
    // useful to it.
    res.status(200).json({ success: true, conversationId, mode });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Assistant participation request timed out");
      const { status, ...body } = ERRORS.ASSISTANT_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Assistant participation request failed",
    );
    const { status, ...body } = ERRORS.UPDATE_FAILED;
    res.status(status).json({ success: false, ...body });
  }
}
