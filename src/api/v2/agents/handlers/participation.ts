import type { Request, Response } from "express";
import { z } from "zod";
import { resolveVariantWorkerOrigin } from "@/api/v2/agents/lib/variant-routing";
import { XMTP_ENV } from "@/config";
import { getAssistantApiKey, getAssistantApiUrl } from "./assistant-config";

const PARTICIPATION_FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_LOG_LIMIT = 200;

// The runtime clamps the hold to its own maximum; this bound only keeps
// absurd values from reaching it.
const MAX_COOLDOWN_SECONDS = 300;

const paramsSchema = z.object({
  instanceId: z.string().trim().min(1, "instanceId is required").max(256),
});

export const bodySchema = z
  .object({
    mode: z.enum(["speak", "mention", "paused"]).optional(),
    // 0 disables the explicit hold and returns the agent to the automatic,
    // member-scaled window.
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_COOLDOWN_SECONDS)
      .optional(),
  })
  .strict()
  .refine(
    (body) => body.mode !== undefined || body.cooldownSeconds !== undefined,
    {
      message: "mode or cooldownSeconds is required",
    },
  );

const querySchema = z.object({
  variantId: z.string().trim().min(1).max(64).optional(),
});

const ERRORS = {
  UPDATE_FAILED: {
    status: 502,
    error: "PARTICIPATION_UPDATE_FAILED",
    message: "Failed to update agent participation",
  },
  NOT_FOUND: {
    status: 404,
    error: "INSTANCE_NOT_FOUND",
    message: "Unknown instanceId",
  },
  DESTROYED: {
    status: 410,
    error: "INSTANCE_DESTROYED",
    message: "Agent no longer exists",
  },
  NOT_READY: {
    status: 409,
    error: "INSTANCE_NOT_READY",
    message: "Agent is not initialized yet",
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
 * Handler for PATCH /api/v2/agents/:instanceId/participation
 *
 * Sets how much an agent may speak in its conversation: "speak" (normal),
 * "mention" (only when addressed) or "paused" (does not run at all).
 *
 * This exists because the app cannot call the runtime's control plane
 * directly. That route is guarded by the shared assistant API key, which must
 * not ship inside a client, so the app authenticates to us and we hold the
 * key. Paused in particular depends on this hop: the level has to reach the
 * runtime's control plane to be recorded before a message arrives, otherwise
 * the agent is still woken and still billed for a turn it will discard.
 *
 * Authorization is "any authenticated account". The product rule is that any
 * member of the conversation may change the level, and membership lives in
 * the XMTP group, which this service cannot read. An owner-only check would
 * be the wrong rule rather than a stricter one, so the account requirement is
 * the boundary until membership is verifiable here.
 */
export async function participationHandler(req: Request, res: Response) {
  const assistantApiUrl = getAssistantApiUrl();
  const assistantApiKey = getAssistantApiKey();

  if (!assistantApiUrl) {
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

  const { instanceId } = parsedParams.data;
  const { mode, cooldownSeconds } = parsedBody.data;

  // Same dev-only variant routing as the join poller: an assistant provisioned
  // on a variant worker does not exist on the default one, so the level would
  // be written to the wrong runtime.
  let assistantBaseUrl = assistantApiUrl.replace(/\/+$/, "");
  const variantId = querySchema.safeParse(req.query).data?.variantId;
  if (variantId && XMTP_ENV !== "production") {
    const origin = await resolveVariantWorkerOrigin(variantId);
    if (origin) assistantBaseUrl = origin;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (assistantApiKey) {
    headers.Authorization = `Bearer ${assistantApiKey}`;
  }

  try {
    const upstream = await fetch(
      `${assistantBaseUrl}/api/assistants/${encodeURIComponent(instanceId)}/participation`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ mode, cooldownSeconds }),
        signal: AbortSignal.timeout(PARTICIPATION_FETCH_TIMEOUT_MS),
      },
    );

    if (upstream.status === 404) {
      const { status, ...body } = ERRORS.NOT_FOUND;
      res.status(status).json({ success: false, ...body });
      return;
    }

    if (upstream.status === 410) {
      const { status, ...body } = ERRORS.DESTROYED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    if (upstream.status === 409) {
      const { status, ...body } = ERRORS.NOT_READY;
      res.status(status).json({ success: false, ...body });
      return;
    }

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
    res.status(200).json({
      success: true,
      instanceId,
      mode: mode ?? null,
      cooldownSeconds: cooldownSeconds ?? null,
    });
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
