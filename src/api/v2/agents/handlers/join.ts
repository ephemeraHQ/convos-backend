import type { Request, Response } from "express";
import { z } from "zod";
import {
  AGENT_POOL_API_KEY,
  AGENT_POOL_URL,
  shouldUseDevBehavior,
  XMTP_ENV,
  type XmtpEnv,
} from "@/config";

const bodySchema = z.object({
  slug: z.string().min(1, "Slug is required").max(2048),
  instructions: z.string().max(4096, "Instructions too long").optional(),
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
    message: "Agent pool request timed out",
  },
} as const;

export function buildInviteUrl(
  slug: string,
  xmtpEnv: XmtpEnv = XMTP_ENV,
): string {
  const domainByEnv: Record<XmtpEnv, string> = {
    production: "popup.convos.org",
    testnet: "testnet.convos.org",
    dev: "dev.convos.org",
    local: "dev.convos.org",
  };
  const domain = domainByEnv[xmtpEnv];
  return `https://${domain}/v2?i=${encodeURIComponent(slug)}`;
}

export function shouldAllowForcedErrors(xmtpEnv: XmtpEnv = XMTP_ENV): boolean {
  return shouldUseDevBehavior(xmtpEnv);
}

/**
 * Handler for POST /api/v2/agents/join
 *
 * Requests an AI agent to join a conversation by claiming an idle instance
 * from the agent pool and directing it to the conversation's invite URL.
 *
 * ## Testing with forced errors
 *
 * Send the `X-Force-Error` header to simulate error responses without
 * hitting the real agent pool. The response is delayed by 5 seconds to
 * mimic real-world latency. Only available when `XMTP_ENV` is not `"production"`.
 * In production, the `X-Force-Error` header is silently ignored and normal
 * logic proceeds.
 *
 * | Header value       | Simulated response                  |
 * |--------------------|-------------------------------------|
 * | `X-Force-Error: 502` | 502 AGENT_PROVISION_FAILED        |
 * | `X-Force-Error: 503` | 503 NO_AGENTS_AVAILABLE           |
 * | `X-Force-Error: 504` | 504 AGENT_POOL_TIMEOUT            |
 *
 * Example:
 * ```
 * curl -X POST https://api.convos.org/api/v2/agents/join \
 *   -H "Authorization: Bearer <jwt>" \
 *   -H "Content-Type: application/json" \
 *   -H "X-Force-Error: 502" \
 *   -d '{"slug": "test-slug"}'
 * ```
 */
export async function joinHandler(req: Request, res: Response) {
  // Force error responses for testing (non-production XMTP env only) — see JSDoc above for usage
  const forceError = shouldAllowForcedErrors()
    ? req.headers["x-force-error"]
    : undefined;
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

  if (!AGENT_POOL_URL || !AGENT_POOL_API_KEY) {
    req.log.error("Agent pool not configured");
    res.status(503).json({
      success: false,
      error: "AGENT_POOL_UNAVAILABLE",
      message: "Agent pool is not configured",
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

  const { slug, instructions } = parsed.data;
  req.log.info({ slug }, "Agent join request received");

  try {
    const joinUrl = buildInviteUrl(slug);
    const agentPoolBaseUrl = AGENT_POOL_URL.replace(/\/+$/, "");

    const poolRes = await fetch(`${agentPoolBaseUrl}/api/pool/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_POOL_API_KEY}`,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        agentName: "Assistant",
        instructions: instructions || "You are a helpful assistant.",
        joinUrl,
      }),
    });

    if (!poolRes.ok) {
      const text = await poolRes.text();
      req.log.error(
        { status: poolRes.status, body: text },
        "Agent pool claim failed",
      );

      if (poolRes.status === 503 || poolRes.status === 404) {
        const { status, ...body } = ERRORS.NO_AGENTS_AVAILABLE;
        res.status(status).json({ success: false, ...body });
        return;
      }

      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const result = (await poolRes.json()) as { joined?: boolean };

    res.status(200).json({
      success: true,
      joined: result.joined ?? false,
    });
    return;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Agent pool request timed out");
      const { status, ...body } = ERRORS.AGENT_POOL_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Agent pool request failed",
    );
    const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
    res.status(status).json({ success: false, ...body });
    return;
  }
}
