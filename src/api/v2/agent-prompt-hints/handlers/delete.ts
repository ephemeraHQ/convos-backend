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
    const deleted = await prisma.agentPromptHint.deleteMany({
      where: { id: parsedParams.data.id },
    });

    if (deleted.count === 0) {
      res.status(404).json({ error: "Agent prompt hint not found" });
      return;
    }

    res.status(200).json({
      object: "agent_prompt_hint",
      id: parsedParams.data.id,
      deleted: true,
    });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to delete agent prompt hint",
    );
    res.status(500).json({ error: "Failed to delete agent prompt hint" });
  }
}
