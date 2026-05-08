import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const sendAlreadyPublished = (res: Response) => {
  res.status(409).json({
    error: {
      code: "ALREADY_PUBLISHED",
      message: "Published agent templates cannot be hard-deleted",
    },
  });
};

const isMissingRowError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2025";

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
      select: { id: true, firstPublishedAt: true },
    });

    if (template === null) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }

    if (template.firstPublishedAt !== null) {
      sendAlreadyPublished(res);
      return;
    }

    try {
      await prisma.agentTemplate.delete({
        where: { id: template.id },
      });
    } catch (error) {
      if (isMissingRowError(error)) {
        res.status(404).json({ error: "Agent template not found" });
        return;
      }

      throw error;
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
