import type { Request, Response } from "express";
import { z } from "zod";
import { XMTP_ENV } from "@/config";

const bodySchema = z.object({
  slug: z.string().min(1, "Slug is required").max(2048),
  instructions: z.string().max(4096, "Instructions too long").optional(),
  // Retained for client compatibility; the new assistant API does not
  // accept this knob, so it is ignored when forwarding.
  skipGreeting: z.boolean().optional(),
});

const FORCE_ERROR_DELAY_MS = 5_000;

const ERRORS = {
  AGENT_PROVISION_FAILED: {
    status: 502,
    error: "AGENT_PROVISION_FAILED",
    message: "Failed to provision agent",
  },
  NO_AGENTS_AVAILABLE: {
    status: 503,
    error: "NO_AGENTS_AVAILABLE",
    message: "No agents are currently available",
  },
  AGENT_POOL_TIMEOUT: {
    status: 504,
    error: "AGENT_POOL_TIMEOUT",
    message: "Agent provisioning request timed out",
  },
} as const;

function buildInviteUrl(slug: string): string {
  const domain =
    XMTP_ENV === "production" ? "popup.convos.org" : "dev.convos.org";
  return `https://${domain}/v2?i=${encodeURIComponent(slug)}`;
}

const assistantResponseSchema = z.object({
  instanceId: z.string().min(1),
});

/**
 * Handler for POST /api/v2/agents/join
 *
 * Requests an AI agent to join a conversation by dispatching the assistant
 * runtime service (convos-assistants) `POST /api/assistants` workflow with
 * the conversation's invite URL.
 *
 * The new assistant service is asynchronous: it returns `{ instanceId }`
 * immediately and the per-assistant container is created in the background.
 * Callers should poll `GET /api/v2/agents/join/:instanceId` to observe the
 * `joinStatus` transitions (`starting → pending_acceptance → joined | failed`).
 *
 * `joined` is therefore always `false` in this response. It is preserved for
 * client compatibility — older clients that read `joined` will see the same
 * "not yet joined, try again" shape they already handled.
 *
 * ## Testing with forced errors
 *
 * Send the `X-Force-Error` header to simulate error responses without hitting
 * the real assistant service. The response is delayed by 5 seconds to mimic
 * real-world latency. Only available when `XMTP_ENV` is not `"production"`.
 *
 * | Header value         | Simulated response             |
 * |----------------------|--------------------------------|
 * | `X-Force-Error: 502` | 502 AGENT_PROVISION_FAILED     |
 * | `X-Force-Error: 503` | 503 NO_AGENTS_AVAILABLE        |
 * | `X-Force-Error: 504` | 504 AGENT_POOL_TIMEOUT         |
 */
export async function joinHandler(req: Request, res: Response) {
  // Force error responses for testing (non-production XMTP env only) — see JSDoc above for usage
  const forceError =
    XMTP_ENV !== "production" ? req.headers["x-force-error"] : undefined;
  const forcedError = Object.values(ERRORS).find(
    (e) => String(e.status) === forceError,
  );
  if (forcedError) {
    req.log.warn(
      `Forcing ${forcedError.status} ${forcedError.error} for testing (${FORCE_ERROR_DELAY_MS}ms delay)`,
    );
    await new Promise((resolve) => setTimeout(resolve, FORCE_ERROR_DELAY_MS));
    const { status, ...body } = forcedError;
    res.status(status).json({ success: false, ...body });
    return;
  }

  const assistantApiUrl = (process.env.ASSISTANT_API_URL ?? "").trim();
  const assistantApiKey = (process.env.ASSISTANT_API_KEY ?? "").trim();

  if (!assistantApiUrl) {
    req.log.error("Assistant API not configured");
    res.status(503).json({
      success: false,
      error: "AGENT_POOL_UNAVAILABLE",
      message: "Assistant API is not configured",
    });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { slug, instructions, skipGreeting } = parsed.data;
  req.log.info({ slug, skipGreeting }, "Agent join request received");

  try {
    const joinUrl = buildInviteUrl(slug);
    const assistantBaseUrl = assistantApiUrl.replace(/\/+$/, "");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (assistantApiKey) {
      headers.Authorization = `Bearer ${assistantApiKey}`;
    }

    const assistantRes = await fetch(`${assistantBaseUrl}/api/assistants`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        name: "Assistant",
        instructions: instructions || "You are a helpful assistant.",
        joinUrl,
      }),
    });

    if (!assistantRes.ok) {
      const text = await assistantRes.text();
      req.log.error(
        { status: assistantRes.status, body: text },
        "Assistant dispatch failed",
      );

      if (assistantRes.status === 503 || assistantRes.status === 404) {
        const { status, ...body } = ERRORS.NO_AGENTS_AVAILABLE;
        res.status(status).json({ success: false, ...body });
        return;
      }

      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const raw = await assistantRes.json();
    const result = assistantResponseSchema.safeParse(raw);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Invalid assistant dispatch response",
      );
      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    res.status(200).json({
      success: true,
      joined: false,
      instanceId: result.data.instanceId,
    });
    return;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Assistant dispatch request timed out");
      const { status, ...body } = ERRORS.AGENT_POOL_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Assistant dispatch request failed",
    );
    const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
    res.status(status).json({ success: false, ...body });
    return;
  }
}
