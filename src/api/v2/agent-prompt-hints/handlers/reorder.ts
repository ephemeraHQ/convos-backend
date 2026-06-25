import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const bodySchema = z.object({
  orders: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int(),
      }),
    )
    .min(1)
    // Reject duplicate ids: a repeated id is last-write-wins and would inflate
    // the returned `updated` count past the number of distinct rows actually
    // touched. With this guard, orders.length is the distinct-row count.
    .refine(
      (orders) => new Set(orders.map((order) => order.id)).size === orders.length,
      { message: "Duplicate hint id in reorder batch" },
    ),
});

export async function reorderHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  try {
    // Apply every sortOrder change atomically so a partial reorder never leaves
    // the list in a half-updated order. A missing id fails the whole
    // transaction (P2025) and surfaces as a 404.
    await prisma.$transaction(
      parsed.data.orders.map((order) =>
        prisma.agentPromptHint.update({
          where: { id: order.id },
          data: { sortOrder: order.sortOrder },
        }),
      ),
    );

    res.status(200).json({ updated: parsed.data.orders.length });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      res
        .status(404)
        .json({ error: "One or more agent prompt hints not found" });
      return;
    }
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to reorder agent prompt hints",
    );
    res.status(500).json({ error: "Failed to reorder agent prompt hints" });
  }
}
