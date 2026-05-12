import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

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
      select: { id: true, ownerAccountId: true },
    });

    if (template === null) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }

    // Ownership guard: reject if caller is not the owner AND not an API key listener
    const callerAccountId = res.locals.accountId;
    const isApiKeyListener = res.locals.isApiKeyListener ?? false;
    if (template.ownerAccountId !== callerAccountId && !isApiKeyListener) {
      res.status(403).json({ error: "Not authorized to delete this template" });
      return;
    }

    // Hard delete is permitted in any publish state. Forks of this template
    // have `forkedFromId` set to null (FK is ON DELETE SET NULL); generations
    // (PR #204+) have `templateId` cleared the same way. The owner accepts
    // that any cached/bookmarked URL pointing at this template will start
    // 404'ing after delete.
    const deleted = await prisma.agentTemplate.deleteMany({
      where: { id: template.id },
    });

    if (deleted.count === 0) {
      // Lost a race with another concurrent delete.
      res.status(404).json({ error: "Agent template not found" });
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
