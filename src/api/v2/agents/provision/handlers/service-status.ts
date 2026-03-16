import type { Request, Response } from "express";
import { z } from "zod";
import { getPoolConfig } from "./pool-config";

const querySchema = z.object({
  instanceId: z.string().trim().min(1, "instanceId is required"),
});

const poolResponseSchema = z.object({
  instanceId: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

const ERRORS = {
  STATUS_FAILED: {
    status: 502,
    error: "SERVICE_STATUS_FAILED",
    message: "Failed to fetch service status",
  },
  POOL_UNAVAILABLE: {
    status: 503,
    error: "AGENT_POOL_UNAVAILABLE",
    message: "Agent pool is not configured",
  },
  POOL_TIMEOUT: {
    status: 504,
    error: "AGENT_POOL_TIMEOUT",
    message: "Agent pool request timed out",
  },
} as const;

export async function serviceStatusHandler(req: Request, res: Response) {
  const pool = getPoolConfig(req);
  if (!pool) {
    const { status, ...body } = ERRORS.POOL_UNAVAILABLE;
    res.status(status).json({ success: false, ...body });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { instanceId } = parsed.data;
  req.log.info({ instanceId }, "Service status request received");

  try {
    const poolRes = await fetch(
      `${pool.poolBaseUrl}/api/proxy/services/status?instanceId=${encodeURIComponent(instanceId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${pool.poolApiKey}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!poolRes.ok) {
      const text = await poolRes.text();
      req.log.error(
        {
          status: poolRes.status,
          bodyPreview: text.substring(0, 200),
          bodyLength: text.length,
        },
        "Service status fetch failed",
      );
      const { status, ...body } = ERRORS.STATUS_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    const raw = await poolRes.json();
    const result = poolResponseSchema.safeParse(raw);

    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Invalid pool response for service status",
      );
      const { status, ...body } = ERRORS.STATUS_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }

    res.status(200).json({
      success: true,
      ...result.data,
    });
    return;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      req.log.error("Service status request timed out");
      const { status, ...body } = ERRORS.POOL_TIMEOUT;
      res.status(status).json({ success: false, ...body });
      return;
    }

    req.log.error(
      { stack: error instanceof Error ? error.stack : undefined },
      "Service status request failed",
    );
    const { status, ...body } = ERRORS.STATUS_FAILED;
    res.status(status).json({ success: false, ...body });
    return;
  }
}
