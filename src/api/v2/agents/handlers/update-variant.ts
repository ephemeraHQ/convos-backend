import type { Response as ExpressResponse, Request } from "express";
import { z } from "zod";
import { liveVariantWhere } from "@/api/v2/agents/lib/variant-routing";
import { XMTP_ENV } from "@/config";
import { accountIdSchema } from "@/utils/account-id";
import { prisma } from "@/utils/prisma";
import { getAssistantApiKey, getAssistantApiUrl } from "./assistant-config";

const paramsSchema = z.object({
  instanceId: z.string().uuid(),
});

const bodySchema = z
  .object({
    variantId: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();

const assistantUpdateResponseSchema = z.object({
  ok: z.literal(true),
  variant: z.string().nullable(),
});

type VariantDescriptor = {
  slug: string;
  label: string;
  whatToTest: string;
  prUrl: string;
};

function serializeVariantDescriptor(variant: VariantDescriptor): string {
  return JSON.stringify({
    slug: variant.slug,
    label: variant.label,
    whatToTest: variant.whatToTest,
    prUrl: variant.prUrl,
  });
}

function statusFromAssistantError(status: number): number {
  if ([400, 401, 403, 404, 409, 410].includes(status)) return status;
  return 502;
}

export async function updateAgentVariantHandler(
  req: Request,
  res: ExpressResponse,
) {
  if (XMTP_ENV === "production") {
    res.status(403).json({ error: "AGENT_VARIANTS_UNAVAILABLE" });
    return;
  }

  const accountId = accountIdSchema.safeParse(res.locals.accountId);
  if (!accountId.success) {
    res.status(403).json({ error: "ACCOUNT_REQUIRED" });
    return;
  }

  const params = paramsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "INVALID_INSTANCE_ID" });
    return;
  }

  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "INVALID_REQUEST_BODY" });
    return;
  }

  const assistantApiUrl = getAssistantApiUrl();
  const assistantApiKey = getAssistantApiKey();
  if (!assistantApiUrl || !assistantApiKey) {
    req.log.error("Assistant API is not configured for variant update");
    res.status(503).json({ error: "NO_AGENTS_AVAILABLE" });
    return;
  }

  let variant: VariantDescriptor | null = null;
  if (body.data.variantId !== null) {
    try {
      variant = await prisma.agentVariant.findFirst({
        where: liveVariantWhere(body.data.variantId),
        select: {
          slug: true,
          label: true,
          whatToTest: true,
          prUrl: true,
        },
      });
    } catch (error) {
      req.log.error(
        { error, variantId: body.data.variantId },
        "Failed to look up agent variant",
      );
      res.status(500).json({ error: "VARIANT_LOOKUP_FAILED" });
      return;
    }

    if (!variant) {
      res.status(404).json({ error: "VARIANT_NOT_FOUND" });
      return;
    }
  }

  const metadataVariant =
    variant === null ? null : serializeVariantDescriptor(variant);
  const assistantUrl = new URL(
    `/api/assistants/${encodeURIComponent(params.data.instanceId)}/variant`,
    assistantApiUrl,
  );

  let upstream: Response;
  try {
    upstream = await fetch(assistantUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${assistantApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerAccountId: accountId.data,
        variant: metadataVariant,
      }),
    });
  } catch (error) {
    req.log.error(
      { error, instanceId: params.data.instanceId },
      "Assistant variant metadata update failed",
    );
    res.status(502).json({ error: "ASSISTANT_VARIANT_UPDATE_FAILED" });
    return;
  }

  let upstreamBody: unknown = null;
  try {
    upstreamBody = await upstream.json();
  } catch {
    upstreamBody = null;
  }

  if (!upstream.ok) {
    req.log.warn(
      {
        instanceId: params.data.instanceId,
        status: upstream.status,
        upstreamBody,
      },
      "Assistant variant metadata update returned an error",
    );
    res.status(statusFromAssistantError(upstream.status)).json({
      error: "ASSISTANT_VARIANT_UPDATE_FAILED",
    });
    return;
  }

  const parsed = assistantUpdateResponseSchema.safeParse(upstreamBody);
  if (!parsed.success) {
    req.log.error(
      {
        instanceId: params.data.instanceId,
        upstreamBody,
        issues: parsed.error.issues,
      },
      "Assistant variant metadata update returned invalid JSON",
    );
    res.status(502).json({ error: "ASSISTANT_VARIANT_UPDATE_FAILED" });
    return;
  }

  res.status(200).json({
    success: true,
    instanceId: params.data.instanceId,
    variantId: variant?.slug ?? null,
    applied: "profile_metadata",
  });
}
