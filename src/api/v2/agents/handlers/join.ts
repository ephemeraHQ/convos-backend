import type { Request, Response } from "express";
import { z } from "zod";
import { XMTP_ENV } from "@/config";
import {
  assistantStatusSchema,
  getAssistantApiKey,
  getAssistantApiUrl,
  getJoinPollIntervalMs,
  getJoinWaitBudgetMs,
} from "./assistant-config";

const bodySchema = z.object({
  slug: z.string().min(1, "Slug is required").max(2048),
  instructions: z.string().max(4096, "Instructions too long").optional(),
  // Retained for client compatibility; the new assistant API does not
  // accept this knob, so it is ignored when forwarding.
  skipGreeting: z.boolean().optional(),
});

const FORCE_ERROR_DELAY_MS = 5_000;

const DISPATCH_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 5_000;
const ERROR_BODY_LOG_LIMIT = 200;

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

const assistantDispatchSchema = z.object({
  instanceId: z.string().min(1),
});

type PollOutcome =
  | { kind: "joined" }
  | { kind: "failed"; reason: string | null }
  | { kind: "pending" };

async function pollUntilJoined(args: {
  assistantBaseUrl: string;
  instanceId: string;
  authHeader: string | undefined;
  deadlineMs: number;
  pollIntervalMs: number;
  log: Request["log"];
}): Promise<PollOutcome> {
  const {
    assistantBaseUrl,
    instanceId,
    authHeader,
    deadlineMs,
    pollIntervalMs,
    log,
  } = args;

  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;

  while (Date.now() < deadlineMs) {
    try {
      const upstream = await fetch(
        `${assistantBaseUrl}/api/assistants/${encodeURIComponent(instanceId)}`,
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        },
      );

      if (!upstream.ok) {
        log.warn(
          { status: upstream.status, instanceId },
          "Assistant status poll returned non-200",
        );
      } else {
        const raw = await upstream.json();
        const parsed = assistantStatusSchema.safeParse(raw);
        if (!parsed.success) {
          log.warn(
            { issues: parsed.error.issues, instanceId },
            "Assistant status poll returned malformed body",
          );
        } else if (parsed.data.joinStatus === "joined") {
          return { kind: "joined" };
        } else if (parsed.data.joinStatus === "failed") {
          return {
            kind: "failed",
            reason: parsed.data.joinFailureReason ?? null,
          };
        }
      }
    } catch (err) {
      // Per-poll errors are non-fatal; keep trying until the deadline.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), instanceId },
        "Assistant status poll errored",
      );
    }

    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
    );
  }

  return { kind: "pending" };
}

/**
 * Handler for POST /api/v2/agents/join
 *
 * Requests an AI agent to join a conversation. Internally dispatches the
 * assistant runtime service (convos-assistants) `POST /api/assistants`
 * workflow with the conversation's invite URL, then server-side polls
 * the upstream status until the agent has joined, the workflow has failed,
 * or the wait budget has elapsed.
 *
 * Response shape preserves the legacy synchronous contract:
 *
 *   { success: true, joined: true  }                  — agent joined within window
 *   { success: true, joined: false, instanceId: ... } — still provisioning;
 *     caller may poll GET /api/v2/agents/join/:instanceId
 *
 * On upstream `failed`, returns 502 AGENT_PROVISION_FAILED.
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

  const assistantApiUrl = getAssistantApiUrl();
  const assistantApiKey = getAssistantApiKey();

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

  const assistantBaseUrl = assistantApiUrl.replace(/\/+$/, "");
  const authHeader = assistantApiKey ? `Bearer ${assistantApiKey}` : undefined;

  let instanceId: string;
  try {
    const joinUrl = buildInviteUrl(slug);
    const dispatchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) dispatchHeaders.Authorization = authHeader;

    const dispatchRes = await fetch(`${assistantBaseUrl}/api/assistants`, {
      method: "POST",
      headers: dispatchHeaders,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      body: JSON.stringify({
        name: "Assistant",
        instructions: instructions || "You are a helpful assistant.",
        joinUrl,
      }),
    });

    if (!dispatchRes.ok) {
      const text = await dispatchRes.text();
      req.log.error(
        {
          status: dispatchRes.status,
          bodyPreview: text.substring(0, ERROR_BODY_LOG_LIMIT),
          bodyLength: text.length,
        },
        "Assistant dispatch failed",
      );

      // 503 = capacity / availability. 404 on the POST collection
      // endpoint is a misconfiguration (wrong URL / deploy mismatch),
      // not a transient capacity issue — fail loud rather than mask it
      // as NO_AGENTS_AVAILABLE.
      if (dispatchRes.status === 503) {
        const { status, ...body } = ERRORS.NO_AGENTS_AVAILABLE;
        res.status(status).json({ success: false, ...body });
        return;
      }

      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const raw = await dispatchRes.json();
    const result = assistantDispatchSchema.safeParse(raw);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Invalid assistant dispatch response",
      );
      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }
    instanceId = result.data.instanceId;
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

  // Dispatch succeeded — block while the workflow spins up. If we exceed the
  // wait budget, fall back to the async contract and hand the caller an
  // instanceId they can poll.
  const deadlineMs = Date.now() + getJoinWaitBudgetMs();
  const outcome = await pollUntilJoined({
    assistantBaseUrl,
    instanceId,
    authHeader,
    deadlineMs,
    pollIntervalMs: getJoinPollIntervalMs(),
    log: req.log,
  });

  if (outcome.kind === "joined") {
    res.status(200).json({ success: true, joined: true, instanceId });
    return;
  }

  if (outcome.kind === "failed") {
    req.log.error(
      { instanceId, reason: outcome.reason },
      "Assistant workflow reported failed",
    );
    const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
    res.status(status).json({ success: false, ...body });
    return;
  }

  // Pending (or all polls errored): return 200 with joined:false + instanceId
  // so the iOS client can keep polling.
  req.log.info(
    { instanceId },
    "Assistant join still pending after server-side wait budget",
  );
  res.status(200).json({ success: true, joined: false, instanceId });
}
