import type { Request, Response } from "express";
import { z } from "zod";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const querySchema = z
  .object({
    status: z.enum(["published", "unlisted"]).optional(),
  })
  .passthrough();

const sendInvalidStatus = (res: Response) => {
  res.status(400).json({
    error: {
      code: "INVALID_PUBLISH_STATUS",
      message: "Publish status must be published or unlisted",
    },
  });
};

export async function publishHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      error: "Invalid request params",
      details: parsedParams.error.issues,
    });
    return;
  }

  const parsedQuery = querySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendInvalidStatus(res);
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
          action: "publish",
        },
        "Unauthorized agent-template access attempt",
      );
      res
        .status(403)
        .json({ error: "Not authorized to publish this template" });
      return;
    }

    // First-publish path is atomic via WHERE-pinned updateMany: it only
    // succeeds if firstPublishedAt is still null at write time, so two
    // concurrent first-publishes can't both initialize the timestamp.
    const firstPublishResult = await prisma.agentTemplate.updateMany({
      where: { id: template.id, firstPublishedAt: null },
      data: {
        firstPublishedAt: new Date(),
        status: parsedQuery.data.status ?? "published",
      },
    });

    if (firstPublishResult.count === 0) {
      // Already published (or row deleted). Re-publish atomically — only
      // matches when firstPublishedAt is non-null, so we won't accidentally
      // overlap with the first-publish branch.
      //
      // Status is normally preserved on re-publish (an unlisted template
      // stays unlisted, archived stays archived; `?status=` is ignored to
      // keep public-state mutations centralised in PATCH). The one
      // exception is when the template is currently in `draft`, which is
      // only reachable for a firstPublishedAt-set row via PATCH (see
      // patch.ts — "published → draft is allowed"). In that case
      // re-publish must take it back out of draft, so we honour
      // `?status=` and default to `published` the same way first-publish
      // does. Otherwise leaving the row at `draft` after the user called
      // /publish would be a no-op surprise.
      const desiredStatus =
        template.status === "draft"
          ? (parsedQuery.data.status ?? "published")
          : template.status;

      const repubResult = await prisma.agentTemplate.updateMany({
        where: { id: template.id, firstPublishedAt: { not: null } },
        data: {
          version: { increment: 1 },
          status: desiredStatus,
        },
      });
      if (repubResult.count === 0) {
        res.status(404).json({ error: "Agent template not found" });
        return;
      }
    }

    const updated = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });

    res.status(200).json(serializeAgentTemplate(updated));
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to publish agent template",
    );
    res.status(500).json({ error: "Failed to publish agent template" });
  }
}
