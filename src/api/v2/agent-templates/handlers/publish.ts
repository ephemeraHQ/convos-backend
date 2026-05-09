import type { Request, Response } from "express";
import { z } from "zod";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  id: z.string().min(1),
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
    const callerAccountId = res.locals.accountId as string | undefined;
    const isApiKeyListener =
      (res.locals.isApiKeyListener as boolean | undefined) ?? false;
    if (template.ownerAccountId !== callerAccountId && !isApiKeyListener) {
      res
        .status(403)
        .json({ error: "Not authorized to publish this template" });
      return;
    }

    const updated =
      template.firstPublishedAt === null
        ? await prisma.agentTemplate.update({
            where: { id: template.id },
            data: {
              firstPublishedAt: new Date(),
              status: parsedQuery.data.status ?? "published",
            },
          })
        : await prisma.agentTemplate.update({
            where: { id: template.id },
            data: {
              version: { increment: 1 },
            },
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
