import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const sendAlreadyPublished = (res: Response) => {
  res.status(409).json({
    error: {
      code: "ALREADY_PUBLISHED",
      message:
        "Agent templates with firstPublishedAt set cannot be hard-deleted",
    },
  });
};

export async function deleteHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      error: "Invalid request params",
      details: parsedParams.error.issues,
    });
    return;
  }

  try {
    const template = await prisma.agentTemplate.findUnique({
      where: { id: parsedParams.data.id },
      select: { id: true, ownerAccountId: true, firstPublishedAt: true },
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
      res.status(403).json({ error: "Not authorized to delete this template" });
      return;
    }

    if (template.firstPublishedAt !== null) {
      sendAlreadyPublished(res);
      return;
    }

    // Atomic delete: a concurrent publish could set firstPublishedAt between
    // the read above and the delete here, so re-check the invariant in the
    // delete WHERE clause and return 409 if a publish slipped in.
    const deleted = await prisma.agentTemplate.deleteMany({
      where: { id: template.id, firstPublishedAt: null },
    });

    if (deleted.count === 0) {
      const stillExists = await prisma.agentTemplate.findUnique({
        where: { id: template.id },
        select: { id: true },
      });

      if (stillExists !== null) {
        sendAlreadyPublished(res);
      } else {
        res.status(404).json({ error: "Agent template not found" });
      }
      return;
    }

    res.status(200).json({
      object: "agent_template",
      id: template.id,
      deleted: true,
    });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to delete agent template",
    );
    res.status(500).json({ error: "Failed to delete agent template" });
  }
}
