import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAssistantApiKey,
  getAssistantApiUrl,
} from "@/api/v2/agents/handlers/assistant-config";
import { resolveVariantWorkerOrigin } from "@/api/v2/agents/lib/variant-routing";

const SPACE_UPSTREAM_FETCH_TIMEOUT_MS = 50_000;
const ERROR_BODY_LOG_LIMIT = 200;

const conversationIdSchema = z
  .string()
  .trim()
  .min(1, "conversationId is required")
  .max(256);

const paramsSchema = z.object({
  conversationId: conversationIdSchema,
});

const querySchema = z.object({
  variantId: z.string().trim().min(1).max(64).optional(),
});

const resultCountsSchema = {
  wrote: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  refusedCount: z.number().int().nonnegative(),
};

const spaceUpstreamResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    conversationId: conversationIdSchema,
    outcome: z.literal("pull_request"),
    prUrl: z.string().url(),
    prNumber: z.number().int().positive(),
    branch: z.string().min(1),
    commitSha: z.string().min(1),
    forkCommitSha: z.string().min(1),
    ...resultCountsSchema,
  }),
  z.object({
    conversationId: conversationIdSchema,
    outcome: z.literal("unchanged"),
    forkCommitSha: z.string().min(1),
    ...resultCountsSchema,
  }),
]);

const upstreamErrorSchema = z.object({
  error: z.string().min(1).max(500),
  code: z.string().min(1).max(64),
});

type PublicError = {
  status: number;
  error: string;
  message: string;
};

const ERRORS = {
  INVALID_REQUEST: {
    status: 400,
    error: "INVALID_REQUEST",
    message: "Invalid Space PR proposal request",
  },
  VARIANT_UNAVAILABLE: {
    status: 409,
    error: "VARIANT_UNAVAILABLE",
    message: "The selected agent variant is unavailable",
  },
  SPACE_NOT_FOUND: {
    status: 404,
    error: "SPACE_NOT_FOUND",
    message: "No Space was found for this conversation",
  },
  SPACE_REPOSITORY_UNAVAILABLE: {
    status: 409,
    error: "SPACE_REPOSITORY_UNAVAILABLE",
    message: "This Space does not have a repository",
  },
  SPACE_UPSTREAM_NOT_ARMED: {
    status: 503,
    error: "SPACE_UPSTREAM_NOT_ARMED",
    message: "The selected Space deployment is not armed for PR proposals",
  },
  SPACE_UPSTREAM_UNAVAILABLE: {
    status: 503,
    error: "SPACE_UPSTREAM_UNAVAILABLE",
    message: "Space PR proposals are unavailable",
  },
  SPACE_UPSTREAM_REFUSED: {
    status: 422,
    error: "SPACE_UPSTREAM_REFUSED",
    message: "The Space changes could not be proposed safely",
  },
  SPACE_UPSTREAM_GITHUB_FAILED: {
    status: 502,
    error: "SPACE_UPSTREAM_GITHUB_FAILED",
    message: "GitHub rejected the Space PR proposal; please try again",
  },
  SPACE_UPSTREAM_FAILED: {
    status: 502,
    error: "SPACE_UPSTREAM_FAILED",
    message: "The Space PR proposal failed",
  },
  SPACE_UPSTREAM_TIMEOUT: {
    status: 504,
    error: "SPACE_UPSTREAM_TIMEOUT",
    message: "The Space PR proposal timed out",
  },
} as const satisfies Record<string, PublicError>;

const UPSTREAM_ERRORS = {
  space_upstream_not_armed: ERRORS.SPACE_UPSTREAM_NOT_ARMED,
  space_not_found: ERRORS.SPACE_NOT_FOUND,
  space_repository_unavailable: ERRORS.SPACE_REPOSITORY_UNAVAILABLE,
  space_repository_provider_unavailable: ERRORS.SPACE_UPSTREAM_UNAVAILABLE,
  space_upstream_refused: ERRORS.SPACE_UPSTREAM_REFUSED,
  space_upstream_github_failed: ERRORS.SPACE_UPSTREAM_GITHUB_FAILED,
  space_upstream_failed: ERRORS.SPACE_UPSTREAM_FAILED,
  space_upstream_timeout: ERRORS.SPACE_UPSTREAM_TIMEOUT,
} as const satisfies Record<string, PublicError>;

function sendError(res: Response, value: PublicError): void {
  const { status, ...body } = value;
  res.status(status).json({ success: false, ...body });
}

function translateUpstreamError(raw: unknown): PublicError {
  const parsed = upstreamErrorSchema.safeParse(raw);
  if (!parsed.success) return ERRORS.SPACE_UPSTREAM_FAILED;

  const { code, error: message } = parsed.data;
  if (!(code in UPSTREAM_ERRORS)) return ERRORS.SPACE_UPSTREAM_FAILED;
  const publicError = UPSTREAM_ERRORS[code as keyof typeof UPSTREAM_ERRORS];
  return code === "space_upstream_refused"
    ? { ...publicError, message }
    : publicError;
}

/**
 * Handler for POST /api/v2/conversations/:conversationId/debug/space-upstream
 *
 * Relays an authenticated Space PR proposal to the assistant Worker. The
 * client never receives the shared Worker credential; it receives the standard
 * v2 success or coded-error envelope instead.
 */
export async function spaceUpstreamHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  const parsedQuery = querySchema.safeParse(req.query);
  if (!parsedParams.success || !parsedQuery.success) {
    sendError(res, ERRORS.INVALID_REQUEST);
    return;
  }

  const conversationId = parsedParams.data.conversationId;
  const variantId = parsedQuery.data.variantId;

  let assistantOrigin: string;
  if (variantId !== undefined) {
    // This mutation can create a GitHub branch and PR from variant-specific
    // code, so it must not silently fall back to the default Worker.
    const resolvedOrigin = await resolveVariantWorkerOrigin(variantId);
    if (!resolvedOrigin) {
      sendError(res, ERRORS.VARIANT_UNAVAILABLE);
      return;
    }
    assistantOrigin = resolvedOrigin;
  } else {
    assistantOrigin = getAssistantApiUrl();
  }

  const assistantApiKey = getAssistantApiKey();
  const assistantBaseUrl = assistantOrigin.replace(/\/+$/, "");
  if (!assistantApiKey) {
    req.log.error("Space upstream Worker is not configured");
    sendError(res, ERRORS.SPACE_UPSTREAM_UNAVAILABLE);
    return;
  }

  try {
    const upstream = await fetch(
      `${assistantBaseUrl}/api/conversations/${encodeURIComponent(conversationId)}/space-upstream`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${assistantApiKey}` },
        signal: AbortSignal.timeout(SPACE_UPSTREAM_FETCH_TIMEOUT_MS),
      },
    );

    if (!upstream.ok) {
      const text = await upstream.text();
      const bodyPreview = text.substring(0, ERROR_BODY_LOG_LIMIT);
      req.log.error(
        { status: upstream.status, bodyPreview },
        "Space upstream Worker request failed",
      );

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      sendError(res, translateUpstreamError(raw));
      return;
    }

    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch {
      raw = null;
    }
    const result = spaceUpstreamResultSchema.safeParse(raw);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Invalid Space upstream Worker response",
      );
      sendError(res, ERRORS.SPACE_UPSTREAM_FAILED);
      return;
    }

    res.status(200).json({ success: true, ...result.data });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Space upstream Worker request timed out");
      sendError(res, ERRORS.SPACE_UPSTREAM_TIMEOUT);
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Space upstream Worker request failed",
    );
    sendError(res, ERRORS.SPACE_UPSTREAM_FAILED);
  }
}
