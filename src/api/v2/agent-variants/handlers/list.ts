import type { Request, Response } from "express";
import { XMTP_ENV } from "@/config";
import { prisma } from "@/utils/prisma";
import { serializeAgentVariant } from "../serialize";

/**
 * GET /v2/agent-variants — the dev app picker's source of truth. Returns the
 * ready/building variants, newest first. Variants exist only on the dev XMTP
 * network, so off-dev the list is empty by contract (the picker treats [] as
 * "no variants"); this is the single dev-only environment gate.
 */
export async function listAgentVariantsHandler(req: Request, res: Response) {
  if (XMTP_ENV === "production") {
    res.status(200).json({ data: [] });
    return;
  }

  try {
    const variants = await prisma.agentVariant.findMany({
      where: { status: { in: ["ready", "building"] } },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ data: variants.map(serializeAgentVariant) });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to list agent variants",
    );
    res.status(500).json({ error: "Failed to list agent variants" });
    return;
  }
}
