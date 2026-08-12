import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAssistantApiKey,
  getAssistantApiUrl,
} from "@/api/v2/agents/handlers/assistant-config";
import { joinStatusQuerySchema } from "@/api/v2/agents/handlers/join-status";
import { resolveVariantWorkerOrigin } from "@/api/v2/agents/lib/variant-routing";

export const SPACE_UPSTREAM_FETCH_TIMEOUT_MS = 50_000;
const ERROR_BODY_LOG_LIMIT = 200;

const conversationIdSchema = z
  .string()
  .regex(/^[0-9A-Za-z_-]{1,128}$/, "Invalid conversationId");

const paramsSchema = z.object({
  conversationId: conversationIdSchema,
});

const resultCountsSchema = {
  wrote: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  refusedCount: z.number().int().nonnegative(),
};

export const spaceUpstreamResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      conversationId: conversationIdSchema,
      outcome: z.literal("pull_request"),
      prUrl: z.string().url(),
      prNumber: z.number().int().positive(),
      branch: z.string().min(1),
      commitSha: z.string().min(1),
      forkCommitSha: z.string().min(1),
      ...resultCountsSchema,
    })
    .strict(),
  z
    .object({
      conversationId: conversationIdSchema,
      outcome: z.literal("unchanged"),
      forkCommitSha: z.string().min(1),
      ...resultCountsSchema,
    })
    .strict(),
]);

const upstreamErrorSchema = z
  .object({
    error: z.string().min(1).max(500),
    code: z.string().min(1).max(64),
  })
  .strict();

type PublicError = {
  status: number;
  code: string;
  error: string;
};

const ERRORS = {
  INVALID_REQUEST: {
    status: 400,
    code: "INVALID_REQUEST",
    error: "Invalid Space PR proposal request",
  },
  VARIANT_UNAVAILABLE: {
    status: 409,
    code: "VARIANT_UNAVAILABLE",
    error: "The selected agent variant is unavailable",
  },
  SPACE_NOT_FOUND: {
    status: 404,
    code: "SPACE_NOT_FOUND",
    error: "No Space was found for this conversation",
  },
  SPACE_REPOSITORY_UNAVAILABLE: {
    status: 409,
    code: "SPACE_REPOSITORY_UNAVAILABLE",
    error: "This Space does not have a repository",
  },
  SPACE_UPSTREAM_NOT_ARMED: {
    status: 503,
    code: "SPACE_UPSTREAM_NOT_ARMED",
    error: "The selected Space deployment is not armed for PR proposals",
  },
  SPACE_UPSTREAM_UNAVAILABLE: {
    status: 503,
    code: "SPACE_UPSTREAM_UNAVAILABLE",
    error: "Space PR proposals are unavailable",
  },
  SPACE_UPSTREAM_REFUSED: {
    status: 422,
    code: "SPACE_UPSTREAM_REFUSED",
    error: "The Space changes could not be proposed safely",
  },
  SPACE_UPSTREAM_GITHUB_FAILED: {
    status: 502,
    code: "SPACE_UPSTREAM_GITHUB_FAILED",
    error: "GitHub rejected the Space PR proposal; please try again",
  },
  SPACE_UPSTREAM_FAILED: {
    status: 502,
    code: "SPACE_UPSTREAM_FAILED",
    error: "The Space PR proposal failed",
  },
  SPACE_UPSTREAM_TIMEOUT: {
    status: 504,
    code: "SPACE_UPSTREAM_TIMEOUT",
    error: "The Space PR proposal timed out",
  },
} as const satisfies Record<string, PublicError>;

function sendError(res: Response, value: PublicError): void {
  const { status, ...body } = value;
  res.status(status).json(body);
}

function translateUpstreamError(status: number, raw: unknown): PublicError {
  const parsed = upstreamErrorSchema.safeParse(raw);
  if (!parsed.success) return ERRORS.SPACE_UPSTREAM_FAILED;

  const { code, error } = parsed.data;
  if (status === 403 && code === "space_upstream_not_armed") {
    return ERRORS.SPACE_UPSTREAM_NOT_ARMED;
  }
  if (status === 404 && code === "space_not_found") {
    return ERRORS.SPACE_NOT_FOUND;
  }
  if (status === 409 && code === "space_repository_unavailable") {
    return ERRORS.SPACE_REPOSITORY_UNAVAILABLE;
  }
  if (status === 503 && code === "space_repository_provider_unavailable") {
    return ERRORS.SPACE_UPSTREAM_UNAVAILABLE;
  }
  if (status === 422 && code === "space_upstream_refused") {
    return { ...ERRORS.SPACE_UPSTREAM_REFUSED, error };
  }
  if (status === 502 && code === "space_upstream_github_failed") {
    return ERRORS.SPACE_UPSTREAM_GITHUB_FAILED;
  }
  if (status === 502 && code === "space_upstream_failed") {
    return ERRORS.SPACE_UPSTREAM_FAILED;
  }
  if (status === 504 && code === "space_upstream_timeout") {
    return ERRORS.SPACE_UPSTREAM_TIMEOUT;
  }
  return ERRORS.SPACE_UPSTREAM_FAILED;
}

export async function spaceUpstreamHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  const parsedQuery = joinStatusQuerySchema.safeParse(req.query);
  if (!parsedParams.success || !parsedQuery.success) {
    sendError(res, ERRORS.INVALID_REQUEST);
    return;
  }

  const conversationId = parsedParams.data.conversationId.toLowerCase();
  const variantId = parsedQuery.data.variantId;

  let assistantOrigin: string;
  if (variantId !== undefined) {
    const resolvedOrigin = await resolveVariantWorkerOrigin(variantId);
    if (!resolvedOrigin) {
      sendError(res, ERRORS.VARIANT_UNAVAILABLE);
      return;
    }
    assistantOrigin = resolvedOrigin;
  } else {
    assistantOrigin = getAssistantApiUrl();
  }

  const assistantApiKey = getAssistantApiKey().trim();
  const assistantBaseUrl = assistantOrigin.trim().replace(/\/+$/, "");
  if (!assistantApiKey || !assistantBaseUrl) {
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
      sendError(res, translateUpstreamError(upstream.status, raw));
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

    res.status(200).json(result.data);
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
