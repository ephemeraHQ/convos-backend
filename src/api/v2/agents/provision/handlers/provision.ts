import type { Request, Response } from "express";
import { z } from "zod";
import { getPoolConfig } from "./pool-config";

const bodySchema = z.object({
  instanceId: z.string().trim().min(1, "instanceId is required"),
});

type ServiceType = "email" | "sms";

const POOL_PATHS: Record<ServiceType, string> = {
  email: "/api/proxy/email/provision",
  sms: "/api/proxy/sms/provision",
};

const poolResponseSchemas = {
  email: z.object({
    email: z.string(),
    provisioned: z.boolean(),
  }),
  sms: z.object({
    phone: z.string(),
    provisioned: z.boolean(),
  }),
} as const;

function makeErrors(service: ServiceType) {
  const label = service.toUpperCase();
  return {
    PROVISION_FAILED: {
      status: 502,
      error: `${label}_PROVISION_FAILED`,
      message: `Failed to provision ${service}`,
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
}

export function createProvisionHandler(service: ServiceType) {
  const ERRORS = makeErrors(service);
  const poolPath = POOL_PATHS[service];
  const responseSchema = poolResponseSchemas[service];

  return async (req: Request, res: Response) => {
    const pool = getPoolConfig(req);
    if (!pool) {
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
    req.log.info({ instanceId }, `${service} provision request received`);

    try {
      const poolRes = await fetch(`${pool.poolBaseUrl}${poolPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pool.poolApiKey}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ instanceId }),
      });

      if (!poolRes.ok) {
        const text = await poolRes.text();
        req.log.error(
          {
            status: poolRes.status,
            bodyPreview: text.substring(0, 200),
            bodyLength: text.length,
          },
          `${service} provision failed`,
        );
        const { status, ...body } = ERRORS.PROVISION_FAILED;
        res.status(status).json({ success: false, ...body });
        return;
      }

      const raw = await poolRes.json();
      const result = responseSchema.safeParse(raw);

      if (!result.success) {
        req.log.error(
          { issues: result.error.issues },
          `Invalid pool response for ${service} provision`,
        );
        const { status, ...body } = ERRORS.PROVISION_FAILED;
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
        req.log.error(`${service} provision request timed out`);
        const { status, ...body } = ERRORS.POOL_TIMEOUT;
        res.status(status).json({ success: false, ...body });
        return;
      }

      req.log.error(
        { stack: error instanceof Error ? error.stack : undefined },
        `${service} provision request failed`,
      );
      const { status, ...body } = ERRORS.PROVISION_FAILED;
      res.status(status).json({ success: false, ...body });
      return;
    }
  };
}
