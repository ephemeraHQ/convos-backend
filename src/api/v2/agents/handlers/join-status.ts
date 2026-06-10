import type { Request, Response } from "express";
import { z } from "zod";
import {
  assistantStatusSchema,
  getAssistantApiKey,
  getAssistantApiUrl,
} from "./assistant-config";

const STATUS_FETCH_TIMEOUT_MS = 15_000;
const ERROR_BODY_LOG_LIMIT = 200;

const paramsSchema = z.object({
  instanceId: z.string().trim().min(1, "instanceId is required").max(256),
});

const ERRORS = {
  STATUS_FAILED: {
    status: 502,
    error: "JOIN_STATUS_FAILED",
    message: "Failed to fetch agent join status",
  },
  NOT_FOUND: {
    status: 404,
    error: "INSTANCE_NOT_FOUND",
    message: "Unknown instanceId",
  },
  ASSISTANT_UNAVAILABLE: {
    status: 503,
    error: "AGENT_POOL_UNAVAILABLE",
    message: "Assistant API is not configured",
  },
  ASSISTANT_TIMEOUT: {
    status: 504,
    error: "AGENT_POOL_TIMEOUT",
    message: "Assistant status request timed out",
  },
} as const;

/**
 * Handler for GET /api/v2/agents/join/:instanceId
 *
 * Polls the assistant runtime service for the current join status of an
 * instance dispatched via POST /api/v2/agents/join.
 *
 * Returns `joined: true` once `joinStatus` is `"joined"` or `"ready"` (the
 * runtime advances joined → ready when the agent finishes booting),
 * mirroring the boolean the legacy pool API returned synchronously from
 * /api/pool/claim.
 */
export async function joinStatusHandler(req: Request, res: Response) {
  const assistantApiUrl = getAssistantApiUrl();
  const assistantApiKey = getAssistantApiKey();

  if (!assistantApiUrl) {
    req.log.error("Assistant API not configured");
    const { status, ...body } = ERRORS.ASSISTANT_UNAVAILABLE;
    res.status(status).json({ success: false, ...body });
    return;
  }

  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { instanceId } = parsed.data;
  const assistantBaseUrl = assistantApiUrl.replace(/\/+$/, "");

  const headers: Record<string, string> = {};
  if (assistantApiKey) {
    headers.Authorization = `Bearer ${assistantApiKey}`;
  }

  try {
    const upstream = await fetch(
      `${assistantBaseUrl}/api/assistants/${encodeURIComponent(instanceId)}`,
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS),
      },
    );

    if (upstream.status === 404) {
      const { status, ...body } = ERRORS.NOT_FOUND;
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
        "Assistant status fetch failed",
      );
      const { status, ...body } = ERRORS.STATUS_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const raw = await upstream.json();
    const result = assistantStatusSchema.safeParse(raw);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Invalid assistant status response",
      );
      const { status, ...body } = ERRORS.STATUS_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const {
      joinStatus,
      inboxId = null,
      conversationId = null,
      joinFailureReason = null,
    } = result.data;

    res.status(200).json({
      success: true,
      instanceId: result.data.instanceId,
      joinStatus,
      joined: joinStatus === "joined" || joinStatus === "ready",
      inboxId,
      conversationId,
      joinFailureReason,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Assistant status request timed out");
      const { status, ...body } = ERRORS.ASSISTANT_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Assistant status request failed",
    );
    const { status, ...body } = ERRORS.STATUS_FAILED;
    res.status(status).json({ success: false, ...body });
  }
}
