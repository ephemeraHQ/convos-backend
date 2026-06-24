import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
});

/**
 * DELETE /v2/agent-variants/:slug — drop a variant row (auth + dev-gate on the
 * route). Idempotent by design: teardown fires on PR close/unlabel and may
 * target a slug that was never registered (a default-runtime variant) or one
 * already removed, so a missing row is a 204, not a 404. `deleteMany` makes
 * the zero-row case a no-op instead of a throw.
 */
export async function deleteAgentVariantHandler(req: Request, res: Response) {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid slug" });
    return;
  }

  try {
    await prisma.agentVariant.deleteMany({ where: { slug: parsed.data.slug } });
    res.status(204).end();
  } catch (error) {
    req.log.error(
      {
        error,
        slug: parsed.data.slug,
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Failed to delete agent variant",
    );
    res.status(500).json({ error: "Failed to delete agent variant" });
  }
}
