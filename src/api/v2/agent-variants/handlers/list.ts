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
    // The picker gets the same liveness rule the router uses, so it can only
    // offer a variant that requests will actually be routed to — listing an
    // expired one invites a device to pin something that silently resolves to
    // the default worker, which reads as the variant doing nothing.
    //
    // The variant-sweep CI (agent API key) gets the unfiltered set: it is the
    // reaper, and an expired row is precisely what it exists to clean up.
    // Hiding those would strand them in the registry forever.
    const isReaper = res.locals.isApiKeyListener === true;
    const variants = await prisma.agentVariant.findMany({
      where: {
        status: { in: ["ready", "building"] },
        ...(isReaper
          ? {}
          : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
      },
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
