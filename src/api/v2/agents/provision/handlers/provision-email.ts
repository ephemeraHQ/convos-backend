import type { Request, Response } from "express";
import { z } from "zod";
import { AGENT_POOL_API_KEY, AGENT_POOL_URL } from "@/config";

const bodySchema = z.object({
  instanceId: z.string().min(1, "instanceId is required"),
});

const ERRORS = {
  PROVISION_FAILED: {
    status: 502,
    error: "EMAIL_PROVISION_FAILED",
    message: "Failed to provision email",
  },
  POOL_UNAVAILABLE: {
    status: 503,
    error: "POOL_UNAVAILABLE",
    message: "Agent pool is not configured",
  },
  POOL_TIMEOUT: {
    status: 504,
    error: "POOL_TIMEOUT",
    message: "Agent pool request timed out",
  },
} as const;

export async function provisionEmailHandler(req: Request, res: Response) {
  if (!AGENT_POOL_URL || !AGENT_POOL_API_KEY) {
    req.log.error("Agent pool not configured");
    const { status, ...body } = ERRORS.POOL_UNAVAILABLE;
    res.status(status).json({ success: false, ...body });
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

  const { instanceId } = parsed.data;
  req.log.info({ instanceId }, "Email provision request received");

  try {
    const poolBaseUrl = AGENT_POOL_URL.replace(/\/+$/, "");

    const poolRes = await fetch(
      `${poolBaseUrl}/api/proxy/email/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AGENT_POOL_API_KEY}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ instanceId }),
      },
    );

    if (!poolRes.ok) {
      const text = await poolRes.text();
      req.log.error(
        { status: poolRes.status, body: text },
        "Email provision failed",
      );
      const { status, ...body } = ERRORS.PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const result = (await poolRes.json()) as {
      email?: string;
      provisioned?: boolean;
    };

    res.status(200).json({
      email: result.email,
      provisioned: result.provisioned,
    });
    return;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Email provision request timed out");
      const { status, ...body } = ERRORS.POOL_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Email provision request failed",
    );
    const { status, ...body } = ERRORS.PROVISION_FAILED;
    res.status(status).json({ success: false, ...body });
    return;
  }
}
