import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// Same length cap as create: the public read filters over-length rows, so the
// admin write keeps stored == served.
const MAX_HINT_LENGTH = 240;

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_HINT_LENGTH).optional(),
  published: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

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

  // Build a partial update from only the provided keys. Hints are global rows,
  // so there is no ownership guard and no status-transition machinery — a plain
  // published boolean, not the templates publish lifecycle.
  const data: Prisma.AgentPromptHintUncheckedUpdateInput = {};
  if (parsedBody.data.text !== undefined) {
    data.text = parsedBody.data.text;
  }
  if (parsedBody.data.published !== undefined) {
    data.published = parsedBody.data.published;
  }
  if (parsedBody.data.sortOrder !== undefined) {
    data.sortOrder = parsedBody.data.sortOrder;
  }

  try {
    const existing = await prisma.agentPromptHint.findUnique({
      where: { id: parsedParams.data.id },
      select: { id: true },
    });

    if (existing === null) {
      res.status(404).json({ error: "Agent prompt hint not found" });
      return;
    }

    if (Object.keys(data).length === 0) {
      const unchanged = await prisma.agentPromptHint.findUniqueOrThrow({
        where: { id: parsedParams.data.id },
      });
      res.status(200).json(unchanged);
      return;
    }

    const updated = await prisma.agentPromptHint.update({
      where: { id: parsedParams.data.id },
      data,
    });
    res.status(200).json(updated);
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to patch agent prompt hint",
    );
    res.status(500).json({ error: "Failed to patch agent prompt hint" });
  }
}
