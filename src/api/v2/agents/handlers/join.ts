import type { Request, Response } from "express";
import { z } from "zod";
import { AGENT_POOL_API_KEY, AGENT_POOL_URL, XMTP_ENV } from "@/config";

const bodySchema = z.object({
  slug: z.string().min(1, "Slug is required").max(2048),
  instructions: z.string().optional(),
});

function buildInviteUrl(slug: string): string {
  const domain =
    XMTP_ENV === "production" ? "popup.convos.org" : "dev.convos.org";
  return `https://${domain}/v2?i=${encodeURIComponent(slug)}`;
}

export async function joinHandler(req: Request, res: Response) {
  if (!AGENT_POOL_URL || !AGENT_POOL_API_KEY) {
    req.log.error("Agent pool not configured");
    res.status(503).json({
      success: false,
      error: "AGENT_POOL_UNAVAILABLE",
      message: "Agent pool is not configured",
    });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { slug, instructions } = parsed.data;
  req.log.info({ slug }, "Agent join request received");

  try {
    const joinUrl = buildInviteUrl(slug);

    const poolRes = await fetch(`${AGENT_POOL_URL}/api/pool/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_POOL_API_KEY}`,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        agentName: "convos-agent",
        instructions: instructions || "You are a helpful assistant.",
        joinUrl,
      }),
    });

    if (!poolRes.ok) {
      const text = await poolRes.text();
      req.log.error(
        { status: poolRes.status, body: text },
        "Agent pool claim failed",
      );

      if (poolRes.status === 503 || poolRes.status === 404) {
        res.status(503).json({
          success: false,
          error: "NO_AGENTS_AVAILABLE",
          message: "No agents are currently available",
        });
        return;
      }

      res.status(502).json({
        success: false,
        error: "AGENT_PROVISION_FAILED",
        message: "Failed to provision agent",
      });
      return;
    }

    const result = (await poolRes.json()) as { joined?: boolean };

    res.status(200).json({
      success: true,
      joined: result.joined ?? false,
    });
    return;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Agent pool request timed out");
      res.status(504).json({
        success: false,
        error: "AGENT_POOL_TIMEOUT",
        message: "Agent pool request timed out",
      });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Agent pool request failed",
    );
    res.status(502).json({
      success: false,
      error: "AGENT_PROVISION_FAILED",
      message: "Failed to provision agent",
    });
    return;
  }
}
