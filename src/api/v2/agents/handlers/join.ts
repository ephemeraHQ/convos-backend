import type { Request, Response } from "express";
import { z } from "zod";
import {
  recordAgentInstanceDispatched,
  recordAgentInstanceStatus,
} from "@/api/v2/agents/lib/agent-instances";
import { buildJoinPayload } from "@/api/v2/agents/lib/build-join-payload";
import {
  allowedVariantWorkerOrigin,
  liveVariantWhere,
  variantWorkerHostname,
} from "@/api/v2/agents/lib/variant-routing";
import { XMTP_ENV } from "@/config";
import { accountIdSchema } from "@/utils/account-id";
import { prisma } from "@/utils/prisma";
import {
  assistantStatusSchema,
  getAssistantApiKey,
  getAssistantApiUrl,
  getJoinPollIntervalMs,
  getJoinWaitBudgetMs,
  type AssistantStatus,
} from "./assistant-config";

const AGENT_BUILDER_ONBOARDING = "agent-builder";

// The public variant descriptor + optional ephemeral runtime URL read from the
// registry for a dev-only per-PR variant join.
type VariantDescriptor = {
  slug: string;
  label: string;
  whatToTest: string;
  prUrl: string;
  assistantWorkerUrl: string | null;
};

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

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "timezone must be a valid IANA timezone identifier");

// Per-join assistant-shaping knobs, forwarded onto convos-assistants'
// free-form `metadata: Record<string, unknown>` bag. Each field is only
// stamped onto metadata when the caller explicitly passes it — we do
// not synthesize defaults at this layer.
const optionsSchema = z
  .object({
    skipGreeting: z.boolean().optional(),
    onboarding: z.string().min(1).max(64).optional(),
    // Per-PR agent variant (dev-only). Selects a registered variant; the backend
    // consumes it here (runtime routing + the metadata stamp) and does NOT forward
    // it to the runtime. Optional + ignored off-dev, so it stays backwards-
    // compatible for shipped clients.
    variantId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

// `.strict()` rejects unknown keys — closes the silent-drop footgun from
// when `instructions` and `templateId` could be combined and the former
// would be discarded. The caller-facing contract is now: send `templateId`
// to apply a template; send neither for a bare agent. There is no escape
// hatch for inline `instructions` — templates are the unit.
//
// `slug` and `conversationId` select the join mechanism (exactly one): with
// a slug, the runtime joins via the invite's join-request DM; with a
// conversationId, the agent is provisioned in direct-add mode — the response
// carries the agent's `inboxId`, the caller adds it to the declared group
// with addMembers, and the runtime attaches when it observes the resulting
// group welcome. No confirmation call exists.
export const bodySchema = z
  .object({
    slug: z.string().min(1, "slug must not be empty").max(2048).optional(),
    // Normalized to lowercase: the runtime forwards this to Herald, whose
    // conversation-id schema is lowercase-only hex.
    conversationId: z
      .string()
      .regex(/^[0-9a-f]+$/i, "conversationId must be a hex string")
      .min(8)
      .max(128)
      .transform((v) => v.toLowerCase())
      .optional(),
    templateId: z.string().uuid().optional(),
    // Client-minted join idempotency key. Forwarded verbatim to the
    // assistants service, where it becomes the Workflow instance id — a
    // retried join whose response was lost (timeout, app suspension)
    // adopts the already-provisioned instance instead of creating a
    // duplicate. Optional for backwards compatibility with shipped
    // clients. Lowercased here as an early gate; the assistants boundary
    // is the authoritative normalizer (instance ids are lowercase-only).
    idempotencyKey: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase())
      .optional(),
    name: z.string().min(1).max(256).optional(),
    profileImage: z.string().min(1).max(2048).optional(),
    options: optionsSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .refine((b) => (b.slug === undefined) !== (b.conversationId === undefined), {
    message:
      "Provide exactly one of slug (invite join) or conversationId (direct-add)",
    path: ["conversationId"],
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
  JOIN_DISPATCH_INVALID: {
    status: 500,
    error: "JOIN_DISPATCH_INVALID",
    message: "Internal error building agent dispatch",
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

// Egress contract for POST {assistant}/api/assistants. The envelope is
// strict and `ownerAccountId` is required — an agent must never be
// provisioned without an owner (the pre-#231 ownerless-agent bug class).
// `template` interior stays loose: it is built from an already-validated
// DB row; this schema guards the envelope, not template evolution.
// Adding a wire field requires updating this schema (.strict() turns a missed
// field into a 500 on every join — deliberately loud), and conversationId here
// is lowercase-only by design: the inbound schema's .transform has already
// canonicalized it.
const dispatchBodySchema = z
  .object({
    joinUrl: z.string().url().optional(),
    conversationId: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .min(8)
      .max(128)
      .optional(),
    template: z.record(z.string(), z.unknown()).nullable(),
    ownerAccountId: accountIdSchema,
    options: optionsSchema.optional(),
    timezone: timezoneSchema.optional(),
    // Join idempotency key, already lowercased by the inbound schema's
    // transform. The worker uses it as the Workflow instance id to dedup
    // retried creates.
    idempotencyKey: z.string().uuid().optional(),
    // Free-form XMTP-profile metadata seed forwarded to the worker. Used to
    // carry the per-PR variant descriptor ({ variant: <json> }), which the
    // worker stamps onto the agent's profile at Herald-join.
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (b) => (b.joinUrl === undefined) !== (b.conversationId === undefined),
    { message: "Exactly one of joinUrl or conversationId" },
  );

type PollOutcome =
  | { kind: "joined"; inboxId: string | null; conversationId: string | null }
  | { kind: "failed"; reason: string | null }
  | { kind: "pending" };

type RegisteredOutcome =
  | { kind: "registered"; inboxId: string }
  | { kind: "failed"; reason: string | null }
  | { kind: "pending" };

async function pollAssistantStatus<Outcome>(args: {
  assistantBaseUrl: string;
  instanceId: string;
  authHeader: string | undefined;
  deadlineMs: number;
  pollIntervalMs: number;
  log: Request["log"];
  abortSignal?: AbortSignal;
  // Maps an upstream status row to a final outcome, or null to keep polling.
  check: (status: AssistantStatus) => Outcome | null;
}): Promise<Outcome | { kind: "pending" }> {
  const {
    assistantBaseUrl,
    instanceId,
    authHeader,
    deadlineMs,
    pollIntervalMs,
    log,
    abortSignal,
    check,
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

    // Cap each status fetch by the remaining wait budget so a hung upstream
    // GET can't hold the response open past the deadline.
    const fetchTimeoutMs = Math.min(POLL_TIMEOUT_MS, deadlineMs - Date.now());
    if (fetchTimeoutMs <= 0) break;

    try {
      const upstream = await fetch(
        `${assistantBaseUrl}/api/assistants/${encodeURIComponent(instanceId)}`,
        {
          method: "GET",
          headers,
          signal: abortSignal
            ? AbortSignal.any([
                AbortSignal.timeout(fetchTimeoutMs),
                abortSignal,
              ])
            : AbortSignal.timeout(fetchTimeoutMs),
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
        } else {
          const outcome = check(parsed.data);
          if (outcome !== null) return outcome;
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

function pollUntilJoined(
  args: Omit<Parameters<typeof pollAssistantStatus<PollOutcome>>[0], "check">,
): Promise<PollOutcome> {
  return pollAssistantStatus<PollOutcome>({
    ...args,
    check: (status) => {
      if (status.joinStatus === "joined" || status.joinStatus === "ready") {
        // Carry the identity facts the status row already holds so the
        // caller can record them (AgentInstance bookkeeping) without an
        // extra status fetch.
        return {
          kind: "joined",
          inboxId: status.inboxId ?? null,
          conversationId: status.conversationId ?? null,
        };
      }
      if (status.joinStatus === "failed") {
        return { kind: "failed", reason: status.joinFailureReason ?? null };
      }
      return null;
    },
  });
}

// Direct-add mode waits only for Herald registration (inboxId lands in the
// status row), not for the join itself — the join happens after the caller
// adds the inbox to the group.
function pollUntilRegisteredAndReady(
  args: Omit<
    Parameters<typeof pollAssistantStatus<RegisteredOutcome>>[0],
    "check"
  >,
): Promise<RegisteredOutcome> {
  return pollAssistantStatus<RegisteredOutcome>({
    ...args,
    check: (status) => {
      if (status.joinStatus === "failed") {
        return { kind: "failed", reason: status.joinFailureReason ?? null };
      }
      // Only treat the agent as registered once it has progressed past
      // "starting" — an inboxId can land in the status row before the
      // assistant is far enough along to be added to the group.
      const registered = ["pending_acceptance", "joined", "ready"].includes(
        status.joinStatus,
      );
      if (registered && status.inboxId)
        return { kind: "registered", inboxId: status.inboxId };
      return null;
    },
  });
}

/**
 * Handler for POST /api/v2/agents/join
 *
 * Requests an AI agent to join a conversation. Internally dispatches the
 * assistant runtime service (convos-assistants) `POST /api/assistants`
 * workflow, then server-side polls the upstream status.
 *
 * With `slug`, the runtime joins via the invite's join-request DM and the
 * poll waits until the agent has joined, the workflow has failed, or the
 * wait budget has elapsed:
 *
 *   { success: true, joined: true  }                  — agent joined within window
 *   { success: true, joined: false, instanceId: ... } — still provisioning;
 *     caller may poll GET /api/v2/agents/join/:instanceId
 *
 * With `conversationId` (direct-add), the poll waits only until the agent's
 * XMTP inbox is registered and responds with it; the caller then adds the
 * inbox to the declared group with addMembers, and the runtime attaches once
 * it observes the resulting group welcome — no further calls required:
 *
 *   { success: true, joined: false, instanceId, inboxId } — add this inbox
 *   { success: true, joined: false, instanceId, inboxId: null } — registration
 *     still in flight; poll GET /api/v2/agents/join/:instanceId for inboxId
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
  // than `req`: `req.on('close')` fires when the request body is fully
  // consumed, which can race the poll loop and falsely abort before the
  // handler has even reached it. `res.on('close')` fires when the underlying
  // connection terminates, and the `!res.writableEnded` guard distinguishes
  // "client disconnected before response" from "response completed normally."
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

  const {
    slug,
    conversationId,
    templateId,
    idempotencyKey,
    name,
    profileImage,
    options,
    timezone,
  } = parsed.data;
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

  // Per-PR agent variant (dev-only). When the join carries a variantId for a
  // registered variant, route provisioning to its ephemeral worker (when one is
  // pinned) and stamp the variant descriptor onto the agent's profile via
  // `metadata` (the worker emits it at Herald-join). The builder-prompt side was
  // already applied at generation. `variantId` is
  // consumed here and never forwarded to the runtime. A missing/invalid variant
  // (or off-dev) falls through to the default worker with no stamp.
  let variant: VariantDescriptor | null = null;
  if (options?.variantId && XMTP_ENV !== "production") {
    try {
      // Only a live variant routes + stamps: exclude failed/stale and expired
      // rows (mirrors the picker's ready/building filter) so a client can't pin a
      // retired runtime by slug. A miss falls through to the default worker.
      variant = await prisma.agentVariant.findFirst({
        where: liveVariantWhere(options.variantId),
        select: {
          slug: true,
          label: true,
          whatToTest: true,
          prUrl: true,
          assistantWorkerUrl: true,
        },
      });
    } catch (error) {
      // A transient DB error on this optional dev-only lookup must not 500 the
      // join — degrade to the default worker with no variant stamp.
      req.log.error(
        { error, variantId: options.variantId },
        "Variant lookup failed; falling back to the default worker",
      );
    }
  }

  // The variant row carries a free-form URL. Before routing the join — and its
  // `Authorization: Bearer` — at it, confirm it's one of our HTTPS dev ephemeral
  // origins; a bad or compromised row otherwise turns this into an SSRF /
  // credential-leak path. A non-matching URL falls back to the default worker
  // (the descriptor stamp still applies, exactly as a default-runtime variant).
  let effectiveAssistantApiUrl = assistantApiUrl;
  if (variant?.assistantWorkerUrl) {
    const allowedOrigin = allowedVariantWorkerOrigin(
      variant.assistantWorkerUrl,
      variantWorkerHostname(variant.slug),
    );
    if (allowedOrigin) {
      effectiveAssistantApiUrl = allowedOrigin;
    } else {
      req.log.warn(
        {
          variantId: variant.slug,
          assistantWorkerUrl: variant.assistantWorkerUrl,
        },
        "Variant assistantWorkerUrl is not an allowed dev ephemeral origin; using the default worker",
      );
    }
  }

  // `/api/v2/agents/join` is mounted behind `authMiddleware` (401s any
  // request without a valid JWT) and gated by `requireAccount` (403s a
  // valid-but-account-less JWT), so under normal routing `accountId` is
  // guaranteed populated by the time we reach the handler. The guard
  // here is defense-in-depth — if the route ever gets remounted without
  // those gates, or the middleware order regresses, we fail closed rather
  // than dispatching an assistant with `ownerAccountId: undefined` and
  // silently breaking downstream authorization (the runtime asserts
  // this value back to the backend when creating user-owned templates
  // mid-conversation, and a phantom owner there would corrupt the
  // ownership chain). Mirrors `requireAccount` exactly (403 + identical
  // body) so the response is the same whichever gate fires — and a 403,
  // not a 401, because the request IS authenticated; it just lacks an
  // account binding.
  const joiningUserAccountId = res.locals.accountId;
  if (
    typeof joiningUserAccountId !== "string" ||
    joiningUserAccountId.length === 0
  ) {
    req.log.error("Missing accountId in request context");
    res.status(403).json({ error: "Account required" });
    return;
  }

  // Mutually-exclusive intents: adopting an existing template versus
  // building a new one in-conversation. Other `onboarding` values
  // (e.g. `"first-impression"`) compose fine with `templateId`.
  if (
    templateId !== undefined &&
    options?.onboarding === AGENT_BUILDER_ONBOARDING
  ) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message:
        "templateId cannot be combined with options.onboarding=agent-builder",
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

  const assistantBaseUrl = effectiveAssistantApiUrl.replace(/\/+$/, "");
  const authHeader = assistantApiKey ? `Bearer ${assistantApiKey}` : undefined;

  let instanceId: string;
  try {
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

    // Direct-add sends the declared conversationId instead of a joinUrl —
    // the runtime then skips the invite dance and watches the conversation
    // for the group welcome the caller's addMembers produces.
    const dispatchBody: Record<string, unknown> = {
      ...(slug !== undefined
        ? { joinUrl: buildInviteUrl(slug) }
        : { conversationId }),
      template: joinPayload?.template ?? null,
      ownerAccountId: joiningUserAccountId,
    };
    if (Object.keys(upstreamOptions).length > 0) {
      dispatchBody.options = upstreamOptions;
    }
    if (timezone !== undefined) {
      dispatchBody.timezone = timezone;
    }
    if (idempotencyKey !== undefined) {
      dispatchBody.idempotencyKey = idempotencyKey;
    }
    // Stamp the variant onto the agent: the worker reads metadata.variant at
    // Herald-join and emits it into the XMTP profile so every participant sees
    // the banner. Carries only the public descriptor — never the runtime URL.
    if (variant) {
      dispatchBody.metadata = {
        variant: JSON.stringify({
          slug: variant.slug,
          label: variant.label,
          whatToTest: variant.whatToTest,
          prUrl: variant.prUrl,
        }),
      };
    }

    const dispatchParse = dispatchBodySchema.safeParse(dispatchBody);
    if (!dispatchParse.success) {
      req.log.error(
        { issues: dispatchParse.error.issues },
        "Dispatch body failed validation - refusing to dispatch",
      );
      const { status, ...body } = ERRORS.JOIN_DISPATCH_INVALID;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const dispatchRes = await fetch(`${assistantBaseUrl}/api/assistants`, {
      method: "POST",
      headers: dispatchHeaders,
      signal: AbortSignal.any([
        AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        clientDisconnect.signal,
      ]),
      body: JSON.stringify(dispatchParse.data),
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

  // Record who pays for this agent. The backend is the sole authority on
  // ownerAccountId (stamped from the caller's JWT, dispatched upstream just
  // above) — persisting it here is what lets conversation payloads carry the
  // owner-computed agentPowerDepleted field (CON-807). Bookkeeping must never
  // fail the join: the agent is already provisioning upstream, so log and
  // continue.
  try {
    await recordAgentInstanceDispatched({
      instanceId,
      ownerAccountId: joiningUserAccountId,
      conversationId: conversationId ?? null,
    });
  } catch (error) {
    req.log.error(
      { error, instanceId },
      "Failed to record agent instance dispatch",
    );
  }

  // Direct-add: wait only for Herald registration so the caller gets the
  // inboxId to add to the group; the join completes when the runtime
  // observes the group welcome their addMembers produces.
  if (slug === undefined) {
    const outcome = await pollUntilRegisteredAndReady({
      assistantBaseUrl,
      instanceId,
      authHeader,
      deadlineMs: Date.now() + getJoinWaitBudgetMs(),
      pollIntervalMs: getJoinPollIntervalMs(),
      log: req.log,
      abortSignal: clientDisconnect.signal,
    });

    if (clientDisconnect.signal.aborted) {
      req.log.info(
        { instanceId },
        "Client disconnected during poll — aborting silently",
      );
      return;
    }

    if (outcome.kind === "failed") {
      req.log.error(
        { instanceId, reason: outcome.reason },
        "Assistant workflow reported failed before registration",
      );
      const { status, ...body } = ERRORS.AGENT_PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    // Pending: registration outlasted the wait budget; the caller polls
    // GET /api/v2/agents/join/:instanceId, which carries inboxId.
    if (outcome.kind === "pending") {
      req.log.info(
        { instanceId },
        "Agent registration still pending after server-side wait budget",
      );
    }
    if (outcome.kind === "registered") {
      try {
        await recordAgentInstanceStatus({
          instanceId,
          inboxId: outcome.inboxId,
          conversationId: null,
        });
      } catch (error) {
        req.log.error(
          { error, instanceId },
          "Failed to record agent instance registration",
        );
      }
    }
    res.status(200).json({
      success: true,
      joined: false,
      instanceId,
      inboxId: outcome.kind === "registered" ? outcome.inboxId : null,
    });
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
    // Invite joins learn the conversation (and inbox) only from the runtime's
    // status row — fill them in now so the participation payload can list
    // this agent. Bookkeeping must not fail an already-successful join.
    try {
      await recordAgentInstanceStatus({
        instanceId,
        inboxId: outcome.inboxId,
        conversationId: outcome.conversationId,
      });
    } catch (error) {
      req.log.error(
        { error, instanceId },
        "Failed to record agent instance join",
      );
    }
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
