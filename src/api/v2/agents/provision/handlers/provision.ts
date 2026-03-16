import type { Request, Response } from "express";
import { z } from "zod";
import { AGENT_POOL_API_KEY, AGENT_POOL_URL } from "@/config";

const bodySchema = z.object({
  instanceId: z.string().trim().min(1, "instanceId is required"),
});

const poolBaseUrl = AGENT_POOL_URL.replace(/\/+$/, "");

type ServiceType = "email" | "sms";

const POOL_PATHS: Record<ServiceType, string> = {
  email: "/api/proxy/email/provision",
  sms: "/api/proxy/sms/provision",
};

const RESPONSE_KEY: Record<ServiceType, "email" | "phone"> = {
  email: "email",
  sms: "phone",
};

const poolEmailResponseSchema = z.object({
  email: z.string(),
  provisioned: z.boolean(),
});

const poolSmsResponseSchema = z.object({
  phone: z.string(),
  provisioned: z.boolean(),
});

const POOL_RESPONSE_SCHEMA: Record<ServiceType, z.ZodType> = {
  email: poolEmailResponseSchema,
  sms: poolSmsResponseSchema,
};

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
  const responseKey = RESPONSE_KEY[service];
  const poolPath = POOL_PATHS[service];
  const responseSchema = POOL_RESPONSE_SCHEMA[service];

  return async (req: Request, res: Response) => {
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
    req.log.info({ instanceId }, `${service} provision request received`);

    try {
      const poolRes = await fetch(`${poolBaseUrl}${poolPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AGENT_POOL_API_KEY}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ instanceId }),
      });

      if (!poolRes.ok) {
        const text = await poolRes.text();
        req.log.error(
          { status: poolRes.status, body: text },
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
        [responseKey]: (result.data as Record<string, unknown>)[responseKey],
        provisioned: (result.data as Record<string, unknown>).provisioned,
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
