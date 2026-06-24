import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";
import { AgentVariantUpsertSchema } from "../schemas";
import { serializeAgentVariant } from "../serialize";

/**
 * POST /v2/agent-variants — create or update a variant, keyed on slug. Called
 * only by the convos-assistants variant CI with the agent API key (auth +
 * dev-gate live on the route). `synchronize` redeploys reuse this to refresh
 * commit/status, so it's an upsert rather than a create.
 */
export async function upsertAgentVariantHandler(req: Request, res: Response) {
  const parsed = AgentVariantUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      message: parsed.error.issues[0]?.message ?? "Invalid body",
    });
    return;
  }

  const { slug, ...rest } = parsed.data;

  try {
    const variant = await prisma.agentVariant.upsert({
      where: { slug },
      create: { slug, ...rest },
      update: rest,
    });
    res.status(200).json(serializeAgentVariant(variant));
  } catch (error) {
    req.log.error(
      { error, slug, stack: error instanceof Error ? error.stack : undefined },
      "Failed to upsert agent variant",
    );
    res.status(500).json({ error: "Failed to upsert agent variant" });
  }
}
