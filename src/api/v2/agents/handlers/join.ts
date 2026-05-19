import type { Request, Response } from "express";
import { z } from "zod";
import { buildJoinPayload } from "@/api/v2/agents/lib/build-join-payload";
import { XMTP_ENV } from "@/config";
import { prisma } from "@/utils/prisma";
import {
  assistantStatusSchema,
  getAssistantApiKey,
  getAssistantApiUrl,
  getJoinPollIntervalMs,
  getJoinWaitBudgetMs,
} from "./assistant-config";

const ASSISTANT_BUILDER_ONBOARDING = "assistant-builder";

type TemplateRow = Awaited<ReturnType<typeof prisma.agentTemplate.findUnique>>;
type TemplateFinder = (id: string) => Promise<TemplateRow>;

const defaultTemplateFinder: TemplateFinder = (id) =>
  prisma.agentTemplate.findUnique({ where: { id } });

let _templateFinder: TemplateFinder = defaultTemplateFinder;

// Test seam — substitute the per-id prisma lookup. Mirrors the
// `__setAssistantConfigOverridesForTests` pattern in `./assistant-config.ts`.
// Pass `null` to restore the default. Not used in production.
export function __setTemplateFinderForTests(
  finder: TemplateFinder | null,
): void {
  _templateFinder = finder ?? defaultTemplateFinder;
}

// Per-join assistant-shaping knobs, forwarded onto convos-assistants'
// free-form `metadata: Record<string, unknown>` bag. Each field is only
// stamped onto metadata when the caller explicitly passes it — we do
// not synthesize defaults at this layer.
const optionsSchema = z
  .object({
    skipGreeting: z.boolean().optional(),
    onboarding: z.string().min(1).max(64).optional(),
  })
  .strict();

// `.strict()` rejects unknown keys — closes the silent-drop footgun from
// when `instructions` and `templateId` could be combined and the former
// would be discarded. The caller-facing contract is now: send `templateId`
// to apply a template; send neither for a bare agent. There is no escape
// hatch for inline `instructions` — templates are the unit.
const bodySchema = z
  .object({
    slug: z.string().min(1, "Slug is required").max(2048),
    templateId: z.string().uuid().optional(),
    name: z.string().min(1).max(256).optional(),
    profileImage: z.string().min(1).max(2048).optional(),
    options: optionsSchema.optional(),
  })
  .strict();

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
  abortSignal?: AbortSignal;
}): Promise<PollOutcome> {
  const {
    assistantBaseUrl,
    instanceId,
    authHeader,
    deadlineMs,
    pollIntervalMs,
    log,
    abortSignal,
  } = args;

  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;

  while (Date.now() < deadlineMs) {
    // Client disconnected before the deadline — stop polling. Any
    // in-flight fetch below also receives the same signal and aborts.
    if (abortSignal?.aborted) {
      log.info(
        { instanceId },
        "Client disconnected during poll — aborting wait",
      );
      return { kind: "pending" };
    }

    try {
      const upstream = await fetch(
        `${assistantBaseUrl}/api/assistants/${encodeURIComponent(instanceId)}`,
        {
          method: "GET",
          headers,
          signal: abortSignal
            ? AbortSignal.any([
                AbortSignal.timeout(POLL_TIMEOUT_MS),
                abortSignal,
              ])
            : AbortSignal.timeout(POLL_TIMEOUT_MS),
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
  // Cancel in-flight upstream work when the client disconnects before we've
  // responded. Saves backend + upstream load on abandoned joins (force-quit
  // mid-provision, network blip mid-poll, etc.). Listen on `res` rather
  // than `req`: `req.on('close')` can fire on body-stream end in some
  // HTTP runtimes (Bun in particular) and would falsely abort before the
  // handler has even reached the poll loop. `res.on('close')` fires when
  // the underlying connection terminates, and the `!res.writableEnded`
  // guard distinguishes "client disconnected before response" from
  // "response completed normally."
  const clientDisconnect = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnect.abort();
    }
  });

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

  const { slug, templateId, name, profileImage, options } = parsed.data;
  // Avoid logging the raw slug (it's a join-token granting conversation
  // access) and the raw `options` (caller-controlled input). Log only the
  // public `templateId` reference + option keys so volumes/cardinality
  // stay bounded.
  req.log.info(
    {
      templateId,
      optionKeys: options ? Object.keys(options) : [],
    },
    "Agent join request received",
  );

  // `/api/v2/agents` is mounted behind `authMiddleware`, which 401s any
  // request without a valid JWT, so under normal routing `accountId` is
  // guaranteed populated by the time we reach the handler. The guard
  // here is defense-in-depth — if the route ever gets remounted without
  // auth, or the middleware order regresses, we fail closed rather than
  // dispatching an assistant with `ownerAccountId: undefined` and
  // silently breaking downstream authorization (the runtime asserts
  // this value back to the backend when creating user-owned templates
  // mid-conversation, and a phantom owner there would corrupt the
  // ownership chain).
  const joiningUserAccountId = res.locals.accountId;
  if (
    typeof joiningUserAccountId !== "string" ||
    joiningUserAccountId.length === 0
  ) {
    req.log.error("Missing accountId in request context");
    res.status(401).json({
      success: false,
      error: "UNAUTHORIZED",
      message: "Authentication required",
    });
    return;
  }

  // Mutually-exclusive intents: adopting an existing template versus
  // building a new one in-conversation. Other `onboarding` values
  // (e.g. `"first-impression"`) compose fine with `templateId`.
  if (
    templateId !== undefined &&
    options?.onboarding === ASSISTANT_BUILDER_ONBOARDING
  ) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message:
        "templateId cannot be combined with options.onboarding=assistant-builder",
    });
    return;
  }

  // Resolve templateId → AgentTemplate row. The handler enforces the
  // publishStatus visibility policy here rather than relying on the
  // catalog resolver, because draft templates are joinable by their
  // owner (the catalog read path is anonymous-first and never surfaces
  // drafts at all).
  let resolvedTemplate: TemplateRow = null;
  if (templateId !== undefined) {
    try {
      resolvedTemplate = await _templateFinder(templateId);
    } catch (err) {
      req.log.error(
        { err, templateId },
        "Failed to load agent template for join",
      );
      res.status(500).json({
        success: false,
        error: "TEMPLATE_LOOKUP_FAILED",
        message: "Failed to load agent template",
      });
      return;
    }

    if (resolvedTemplate === null) {
      res.status(404).json({
        success: false,
        error: "TEMPLATE_NOT_FOUND",
        message: "Agent template not found",
      });
      return;
    }

    switch (resolvedTemplate.status) {
      case "published":
      case "unlisted":
        break;
      case "draft":
        if (resolvedTemplate.ownerAccountId !== joiningUserAccountId) {
          req.log.warn(
            {
              templateId,
              ownerAccountId: resolvedTemplate.ownerAccountId,
              callerAccountId: joiningUserAccountId,
            },
            "Caller is not the owner of a draft template",
          );
          res.status(403).json({
            success: false,
            error: "TEMPLATE_FORBIDDEN",
            message: "Not authorized to use this template",
          });
          return;
        }
        break;
      case "archived":
        res.status(410).json({
          success: false,
          error: "TEMPLATE_ARCHIVED",
          message: "Agent template has been archived",
        });
        return;
      default: {
        // Forcing function: if a future maintainer adds a value to
        // `PublishStatus` without updating this switch, the assignment
        // below is a compile error — `status` would narrow to the new
        // value instead of `never`. The runtime arm is the matching
        // safety net for DB drift (e.g. a row written by a system that
        // doesn't share our enum view): fail closed rather than
        // silently falling through to dispatch.
        const _exhaustive: never = resolvedTemplate.status;
        void _exhaustive;
        req.log.error(
          { templateId, status: resolvedTemplate.status },
          "Unexpected template status",
        );
        res.status(500).json({
          success: false,
          error: "TEMPLATE_STATUS_INVALID",
          message: "Template has an invalid status",
        });
        return;
      }
    }
  }

  const assistantBaseUrl = assistantApiUrl.replace(/\/+$/, "");
  const authHeader = assistantApiKey ? `Bearer ${assistantApiKey}` : undefined;

  let instanceId: string;
  try {
    const joinUrl = buildInviteUrl(slug);
    const dispatchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) dispatchHeaders.Authorization = authHeader;

    // Forward each option only when the caller explicitly passed it —
    // no defaults at this layer. `options` is omitted entirely from the
    // upstream payload when neither field is set, so the dispatch body
    // stays minimal in the common path.
    const upstreamOptions: Record<string, unknown> = {};
    if (options?.skipGreeting !== undefined) {
      upstreamOptions.skipGreeting = options.skipGreeting;
    }
    if (options?.onboarding !== undefined) {
      upstreamOptions.onboarding = options.onboarding;
    }

    // Build the wire body. The full AgentTemplate JSON (minus the
    // template's own `ownerAccountId`) rides as a single top-level
    // `template` field. Bare join: `template` is null and the runtime
    // provisions an agent with no template on disk.
    //
    // Caller-supplied `name`/`profileImage` are applied here by
    // spreading onto the row before `buildJoinPayload`, which keeps the
    // builder a one-shot transform over an AgentTemplate.
    const templateWithOverrides: TemplateRow = resolvedTemplate
      ? {
          ...resolvedTemplate,
          ...(name !== undefined ? { agentName: name } : {}),
          ...(profileImage !== undefined ? { avatarUrl: profileImage } : {}),
        }
      : null;

    const joinPayload = templateWithOverrides
      ? buildJoinPayload({
          template: templateWithOverrides,
          joiningUserAccountId,
        })
      : null;

    const dispatchBody: Record<string, unknown> = {
      joinUrl,
      template: joinPayload?.template ?? null,
      ownerAccountId: joiningUserAccountId,
    };
    if (Object.keys(upstreamOptions).length > 0) {
      dispatchBody.options = upstreamOptions;
    }

    const dispatchRes = await fetch(`${assistantBaseUrl}/api/assistants`, {
      method: "POST",
      headers: dispatchHeaders,
      signal: AbortSignal.any([
        AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        clientDisconnect.signal,
      ]),
      body: JSON.stringify(dispatchBody),
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

      // 404 on POST /api/assistants is never a capacity issue — it's
      // almost always wrong ASSISTANT_API_URL or a deploy mismatch.
      // Log distinctly so operators can grep for misconfig vs other
      // upstream failures without re-checking response statuses. Don't
      // log `slug` here — it's the join token (see sanitized log above).
      if (dispatchRes.status === 404) {
        req.log.error(
          { assistantBaseUrl },
          "Assistant dispatch returned 404 — likely ASSISTANT_API_URL misconfiguration or upstream deploy mismatch",
        );
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

    // Client disconnected mid-dispatch — `clientDisconnect.signal` aborted
    // the fetch (AbortSignal.any composed it with the timeout signal).
    // There's no live response to send to, so just return silently
    // instead of falling through to the generic 502 handler and writing
    // to a closed connection.
    if (error instanceof DOMException && error.name === "AbortError") {
      req.log.info("Client disconnected during dispatch — aborting silently");
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
    abortSignal: clientDisconnect.signal,
  });

  // Client disconnected during the poll phase — `pollUntilJoined` swallows
  // per-poll aborts and falls out with `{ kind: "pending" }` (or even
  // `"joined"` if a successful poll happened to land in the race window
  // between loop exit and disconnect). Either way there's no live
  // response to write to; falling through would (1) crash on a write
  // to a closed connection and (2) log the misleading "pending after
  // wait budget" message. Mirror the dispatch-phase silent-return.
  if (clientDisconnect.signal.aborted) {
    req.log.info(
      { instanceId },
      "Client disconnected during poll — aborting silently",
    );
    return;
  }

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
