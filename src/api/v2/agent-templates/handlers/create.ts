import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { pickCollisionFreeId } from "@/api/v2/agent-templates/lib/pick-collision-free-id";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import { getEffectiveOwnerId } from "@/utils/auth-helpers";
import { prisma } from "@/utils/prisma";
import { validateSlug } from "@/utils/reserved-slugs";

const MAX_AUTO_SLUG_ATTEMPTS = 50;

const bodySchema = z
  .object({
    agentName: z.string().trim().min(1),
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
  })
  .passthrough();

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

const sendSlugConflict = (res: Response) => {
  res.status(409).json({
    error: {
      code: "SLUG_CONFLICT",
      message: "Slug already exists for this owner",
    },
  });
};

const isSlugUniqueConstraintError = (error: unknown) => {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("ownerAccountId") && target.includes("slug");
  }

  return typeof target === "string" && target.includes("slug");
};

const hasSlugConflict = async (args: {
  ownerAccountId: string;
  slug: string;
}) => {
  const existing = await prisma.agentTemplate.findFirst({
    where: {
      ownerAccountId: args.ownerAccountId,
      slug: args.slug,
    },
    select: { id: true },
  });

  return existing !== null;
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
      forkedFromId: null,
      agentName: args.body.agentName,
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

const createWithExplicitSlug = async (args: {
  body: CreateBody;
  res: Response;
  slug: string;
  ownerAccountId: string;
}) => {
  const validation = validateSlug(args.slug);
  if (!validation.valid) {
    sendSlugValidationError(args.res, validation);
    return null;
  }

  if (
    await hasSlugConflict({
      ownerAccountId: args.ownerAccountId,
      slug: validation.slug,
    })
  ) {
    sendSlugConflict(args.res);
    return null;
  }

  try {
    const id = await pickCollisionFreeId({ baseSlug: validation.slug });
    return await createTemplateRow({
      body: args.body,
      id,
      slug: validation.slug,
      ownerAccountId: args.ownerAccountId,
    });
  } catch (error) {
    if (isSlugUniqueConstraintError(error)) {
      sendSlugConflict(args.res);
      return null;
    }

    throw error;
  }
};

const createWithAutoSlug = async (args: {
  body: CreateBody;
  res: Response;
  ownerAccountId: string;
}) => {
  const baseSlug = deriveSlugFromAgentName(args.body.agentName);
  const baseValidation = validateSlug(baseSlug);
  if (!baseValidation.valid) {
    sendSlugValidationError(args.res, baseValidation);
    return null;
  }

  // attempt 0 → bare base slug; attempt 2+ → baseSlug-N (skip -1)
  const startAttempt = 0;

  for (
    let attempt = startAttempt;
    attempt <= MAX_AUTO_SLUG_ATTEMPTS;
    attempt++
  ) {
    if (attempt === 1) {
      continue; // skip -1 suffix; first suffix is -2
    }

    const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
    const candidateValidation = validateSlug(candidate);
    if (!candidateValidation.valid) {
      sendSlugValidationError(args.res, candidateValidation);
      return null;
    }

    if (
      await hasSlugConflict({
        ownerAccountId: args.ownerAccountId,
        slug: candidateValidation.slug,
      })
    ) {
      continue;
    }

    try {
      const id = await pickCollisionFreeId({
        baseSlug: candidateValidation.slug,
      });
      return await createTemplateRow({
        body: args.body,
        id,
        slug: candidateValidation.slug,
        ownerAccountId: args.ownerAccountId,
      });
    } catch (error) {
      if (isSlugUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }

  sendSlugConflict(args.res);
  return null;
};

export async function createHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const ownerAccountId = getEffectiveOwnerId(res);
  if (!ownerAccountId) {
    res.status(403).json({ error: "Account required" });
    return;
  }

  try {
    const template =
      parsed.data.slug === undefined
        ? await createWithAutoSlug({
            body: parsed.data,
            res,
            ownerAccountId,
          })
        : await createWithExplicitSlug({
            body: parsed.data,
            res,
            slug: parsed.data.slug,
            ownerAccountId,
          });

    if (template === null) {
      return;
    }

    res.status(201).json(serializeAgentTemplate(template));
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to create agent template",
    );
    res.status(500).json({ error: "Failed to create agent template" });
  }
}
