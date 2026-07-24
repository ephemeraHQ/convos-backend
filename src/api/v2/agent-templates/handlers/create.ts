import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { normalizeJobTitle } from "@/api/v2/agent-templates/lib/normalize-job-title";
import { pickCollisionFreeId } from "@/api/v2/agent-templates/lib/pick-collision-free-id";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import {
  redactTemplatePii,
  type RedactableFields,
} from "@/api/v2/agent-templates/services/moderation";
import { revalidateTemplate } from "@/api/v2/agent-templates/services/revalidate-dashboard";
import { accountIdSchema } from "@/utils/account-id";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";
import { validateSlug } from "@/utils/reserved-slugs";

const bodySchema = z.object({
  agentName: z.string().trim().min(1),
  jobTitle: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  connections: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  emoji: z.string().nullable().optional(),
  featured: z.boolean().optional(),
  prompt: z
    .string()
    .max(50_000, {
      message: "prompt exceeds maximum length of 50_000 characters",
    })
    .refine((value) => value.trim().length > 0, {
      message: "prompt is required",
    }),
  slug: z.string().optional(),
  tools: z.array(z.string()).optional(),
  // Asserted owner — honoured only when the caller is agent-key-auth'd;
  // ignored for JWT (the JWT account always wins) and anonymous. Mirrors
  // the generations POST endpoint's owner-assertion contract so a trusted
  // agent runtime can attribute a created template to the user it's acting
  // on behalf of rather than the ADMIN seed account.
  ownerAccountId: accountIdSchema.optional(),
  // Provenance for forks. When a row is created as a copy of an existing
  // template (e.g. the runtime forking a catalog template a group adopted),
  // this records the source id. The FK (`forkedFromId → AgentTemplate.id`,
  // ON DELETE SET NULL) is the canonical check — a dangling reference fails
  // the insert and maps to the same 400 as a bad ownerAccountId below.
  forkedFromId: z.string().uuid().optional(),
});

type CreateBody = z.infer<typeof bodySchema>;

const deriveSlugFromAgentName = (agentName: string) =>
  agentName.toLowerCase().replace(/\s+/g, "-");

const slugErrorCode = (reason: string) =>
  reason === "reserved" ? "RESERVED_SLUG" : "INVALID_SLUG";

const sendSlugValidationError = (
  res: Response,
  validation: Exclude<ReturnType<typeof validateSlug>, { valid: true }>,
) => {
  res.status(400).json({
    error: {
      code: slugErrorCode(validation.reason),
      message: validation.message,
    },
  });
};

const createTemplateRow = (args: {
  body: CreateBody;
  id: string;
  slug: string;
  ownerAccountId: string;
}) =>
  prisma.agentTemplate.create({
    data: {
      id: args.id,
      slug: args.slug,
      ownerAccountId: args.ownerAccountId,
      forkedFromId: args.body.forkedFromId ?? null,
      agentName: args.body.agentName,
      jobTitle: normalizeJobTitle(args.body.jobTitle),
      description: args.body.description ?? null,
      prompt: args.body.prompt,
      category: args.body.category ?? null,
      emoji: args.body.emoji ?? null,
      avatarUrl: args.body.avatarUrl ?? null,
      tools: args.body.tools ?? [],
      connections: args.body.connections ?? [],
      version: 1,
      firstPublishedAt: null,
      status: "draft",
      featured: args.body.featured ?? false,
    },
  });

export async function createHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  // Owner resolution mirrors the generations POST endpoint:
  //   - Agent-key auth: the caller may assert which account to attribute the
  //     row to via body.ownerAccountId, validated against the Account table
  //     (invalid → 400 rather than a phantom owner). Absent an assertion it
  //     falls back to the agent-key default (ADMIN, via getEffectiveOwnerId).
  //   - JWT auth: the JWT account always wins; body.ownerAccountId is ignored
  //     (users can't create rows owned by someone else).
  //   - Anonymous: no account → 403 below.
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;

  // Featuring is curation, and the gallery is the homepage's — not the template
  // owner's. Anyone may create a template; only the dashboard may put one in
  // front of everybody. Without this an ordinary signed-in user could mint a
  // self-featured template in a single request and publish it into the gallery
  // convos.org renders.
  //
  // Asking for `featured: false` is a no-op and passes: the runtime's builder
  // sends it on every create, and a template that isn't featured is exactly what
  // a create would produce anyway.
  if (parsed.data.featured === true && !isApiKeyListener) {
    req.log.warn(
      { callerAccountId: res.locals.accountId, action: "create.featured" },
      "Unauthorized agent-template curation attempt",
    );
    res.status(403).json({ error: "Not authorized to feature a template" });
    return;
  }

  let ownerAccountId: string | undefined;
  if (isApiKeyListener && parsed.data.ownerAccountId !== undefined) {
    const assertedAccountId = parsed.data.ownerAccountId;
    // Best-effort early validation; the FK constraint on the insert is the
    // canonical check and covers the delete-between-check-and-insert race
    // (handled in the catch block below).
    const exists = await prisma.account.findUnique({
      where: { id: assertedAccountId },
      select: { id: true },
    });
    if (!exists) {
      res.status(400).json({ error: "Asserted ownerAccountId does not exist" });
      return;
    }
    ownerAccountId = assertedAccountId;
  } else {
    ownerAccountId = getEffectiveOwnerId(res);
  }
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  // Validate the fork source if asserted. Like ownerAccountId, the FK is the
  // canonical check (handled in the catch below); this pre-check fails fast
  // with a clear error before the collision-free-id lookup.
  //
  // Policy: forking is intentionally NOT gated on the source's visibility or
  // ownership. `forkedFromId` is provenance only — a bare id pointer that
  // grants no access to the source's content (a non-owner still 404s when
  // resolving a draft/private source), so recording it can't leak anything.
  // Source ids are unguessable UUIDs, so the existence check ("does not exist"
  // vs created) is not a useful oracle. Keeping it ungated also lets the
  // agent-key path (which can see every row) fork the catalog template a group
  // adopted without a special case. If a visibility rule is ever wanted, add
  // it here.
  if (parsed.data.forkedFromId !== undefined) {
    const source = await prisma.agentTemplate.findUnique({
      where: { id: parsed.data.forkedFromId },
      select: { id: true },
    });
    if (!source) {
      res.status(400).json({ error: "forkedFromId does not exist" });
      return;
    }
  }

  // Slugs are not unique. An explicit slug is taken verbatim; an absent one
  // is derived from agentName. Either way it only has to pass format /
  // reserved-word validation — duplicate slugs (within or across owners) are
  // allowed and disambiguated by the hashed-slug URL (`<slug>.<hash>`).
  const rawSlug =
    parsed.data.slug === undefined
      ? deriveSlugFromAgentName(parsed.data.agentName)
      : parsed.data.slug;
  const validation = validateSlug(rawSlug);
  if (!validation.valid) {
    sendSlugValidationError(res, validation);
    return;
  }

  // PII redaction — scrub personal data from the content fields before the row
  // is persisted (and later shared/cloned). Fails CLOSED: a scan error rejects
  // the create rather than persisting un-scanned content.
  let redacted: RedactableFields;
  try {
    ({ fields: redacted } = await redactTemplatePii({
      agentName: parsed.data.agentName,
      description: parsed.data.description ?? undefined,
      prompt: parsed.data.prompt,
    }));
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "PII redaction failed for agent template create",
    );
    res.status(502).json({ error: "Content scan failed, please retry" });
    return;
  }

  try {
    const id = await pickCollisionFreeId({ baseSlug: validation.slug });
    const template = await createTemplateRow({
      body: {
        ...parsed.data,
        agentName: redacted.agentName ?? parsed.data.agentName,
        description: redacted.description ?? parsed.data.description,
        prompt: redacted.prompt ?? parsed.data.prompt,
      },
      id,
      slug: validation.slug,
      ownerAccountId,
    });

    void revalidateTemplate({
      id: template.id,
      slug: template.slug,
      log: req.log,
    });

    res.status(201).json(serializeAgentTemplate(template));
  } catch (error) {
    // Race: a referenced row (ownerAccountId → Account, or forkedFromId →
    // AgentTemplate) was deleted between the pre-check and this insert, so its
    // FK fires. Map back to a 400 so the error code is stable regardless of
    // race timing.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      res.status(400).json({
        error: "Referenced ownerAccountId or forkedFromId does not exist",
      });
      return;
    }
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to create agent template",
    );
    res.status(500).json({ error: "Failed to create agent template" });
  }
}
