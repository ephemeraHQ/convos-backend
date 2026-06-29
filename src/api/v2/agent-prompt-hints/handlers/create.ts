import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// Hard-cap the admin write at the same length the public read enforces. The DB
// column is generous TEXT, but storing an over-length hint here would create an
// invisible row the public endpoint silently drops, so what an admin saves is
// exactly what ships.
const MAX_HINT_LENGTH = 240;

const bodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_HINT_LENGTH),
  published: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
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

  // Only set the optional columns when provided so the schema defaults
  // (published true, sortOrder 0) apply when they're omitted.
  const data: Prisma.AgentPromptHintUncheckedCreateInput = {
    text: parsed.data.text,
  };
  if (parsed.data.published !== undefined) {
    data.published = parsed.data.published;
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }

  try {
    const hint = await prisma.agentPromptHint.create({ data });
    res.status(201).json(hint);
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to create agent prompt hint",
    );
    res.status(500).json({ error: "Failed to create agent prompt hint" });
    return;
  }
}
