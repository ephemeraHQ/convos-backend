import { Prisma, type PublishStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import { prisma } from "@/utils/prisma";
import { validateSlug } from "@/utils/reserved-slugs";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const statusSchema = z.enum(["draft", "published", "unlisted", "archived"]);

const bodySchema = z
  .object({
    agentName: z.string().trim().min(1).optional(),
    avatarUrl: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    connections: z.array(z.string()).optional(),
    description: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    prompt: z
      .string()
      .max(50_000, { message: "prompt exceeds maximum length of 50_000 characters" })
      .refine((value) => value.trim().length > 0, {
        message: "prompt must not be empty",
      })
      .optional(),
    slug: z.string().optional(),
    status: statusSchema.optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

type PatchBody = z.infer<typeof bodySchema>;

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

const sendBadRequest = (
  res: Response,
  args: { code: string; message: string },
) => {
  res.status(400).json({
    error: {
      code: args.code,
      message: args.message,
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
  templateId: string;
}) => {
  const existing = await prisma.agentTemplate.findFirst({
    where: {
      ownerAccountId: args.ownerAccountId,
      slug: args.slug,
      id: { not: args.templateId },
    },
    select: { id: true },
  });

  return existing !== null;
};

const applyContentFields = (
  data: Prisma.AgentTemplateUncheckedUpdateInput,
  body: PatchBody,
) => {
  if (body.agentName !== undefined) {
    data.agentName = body.agentName;
  }
  if (body.avatarUrl !== undefined) {
    data.avatarUrl = body.avatarUrl;
  }
  if (body.category !== undefined) {
    data.category = body.category;
  }
  if (body.connections !== undefined) {
    data.connections = body.connections;
  }
  if (body.description !== undefined) {
    data.description = body.description;
  }
  if (body.emoji !== undefined) {
    data.emoji = body.emoji;
  }
  if (body.prompt !== undefined) {
    data.prompt = body.prompt;
  }
  if (body.tools !== undefined) {
    data.tools = body.tools;
  }
};

const validateStatusTransition = (args: {
  currentStatus: PublishStatus;
  nextStatus: PublishStatus;
}) => {
  if (args.nextStatus === args.currentStatus) {
    return null;
  }

  if (args.currentStatus === "draft") {
    return "Draft templates must be published with POST /publish";
  }

  // Published → draft IS allowed: lets a caller take a previously-public
  // template out of public view (resolver only matches non-draft, so the
  // canonical URL stops resolving for non-owners). `firstPublishedAt`
  // stays set, so the slug remains locked and the next /publish call
  // takes the re-publish path (version bump rather than version reset).

  return null;
};

export async function patchHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      error: "Invalid request params",
      details: parsedParams.error.issues,
    });
    return;
  }

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsedBody.error.issues,
    });
    return;
  }

  try {
    const template = await prisma.agentTemplate.findUnique({
      where: { id: parsedParams.data.id },
    });

    if (template === null) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }

    // Ownership guard: reject if caller is not the owner AND not an API key listener
    const callerAccountId = res.locals.accountId;
    const isApiKeyListener = res.locals.isApiKeyListener ?? false;
    if (template.ownerAccountId !== callerAccountId && !isApiKeyListener) {
      req.log.warn(
        {
          callerAccountId,
          templateId: template.id,
          ownerAccountId: template.ownerAccountId,
          action: "patch",
        },
        "Unauthorized agent-template access attempt",
      );
      res.status(403).json({ error: "Not authorized to modify this template" });
      return;
    }

    const data: Prisma.AgentTemplateUncheckedUpdateInput = {};
    applyContentFields(data, parsedBody.data);

    if (parsedBody.data.slug !== undefined) {
      if (template.firstPublishedAt !== null) {
        sendBadRequest(res, {
          code: "SLUG_IMMUTABLE",
          message: "Slug is immutable once the template has been published",
        });
        return;
      }

      const validation = validateSlug(parsedBody.data.slug);
      if (!validation.valid) {
        sendSlugValidationError(res, validation);
        return;
      }

      if (
        await hasSlugConflict({
          ownerAccountId: template.ownerAccountId,
          slug: validation.slug,
          templateId: template.id,
        })
      ) {
        sendSlugConflict(res);
        return;
      }

      data.slug = validation.slug;
    }

    if (parsedBody.data.status !== undefined) {
      const transitionError = validateStatusTransition({
        currentStatus: template.status,
        nextStatus: parsedBody.data.status,
      });

      if (transitionError !== null) {
        sendBadRequest(res, {
          code: "INVALID_STATUS_TRANSITION",
          message: transitionError,
        });
        return;
      }

      data.status = parsedBody.data.status;
    }

    if (Object.keys(data).length === 0) {
      res.status(200).json(serializeAgentTemplate(template));
      return;
    }

    try {
      // Pin the WHERE clause to the row state we just validated. A concurrent
      // publish, slug rename, ownership transfer or status flip would
      // invalidate our invariant checks above, so any such mutation drops us
      // into the count === 0 branch and surfaces as a 409 (or 404 if the row
      // was deleted).
      const result = await prisma.agentTemplate.updateMany({
        where: {
          id: template.id,
          ownerAccountId: template.ownerAccountId,
          slug: template.slug,
          status: template.status,
          firstPublishedAt: template.firstPublishedAt,
        },
        data,
      });

      if (result.count === 0) {
        const stillExists = await prisma.agentTemplate.findUnique({
          where: { id: template.id },
          select: { id: true },
        });
        if (stillExists === null) {
          res.status(404).json({ error: "Agent template not found" });
        } else {
          res.status(409).json({
            error: {
              code: "TEMPLATE_MODIFIED",
              message:
                "Agent template was modified by another request; reload and retry",
            },
          });
        }
        return;
      }

      const updated = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });

      res.status(200).json(serializeAgentTemplate(updated));
    } catch (error) {
      if (isSlugUniqueConstraintError(error)) {
        sendSlugConflict(res);
        return;
      }

      throw error;
    }
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to patch agent template",
    );
    res.status(500).json({ error: "Failed to patch agent template" });
  }
}
