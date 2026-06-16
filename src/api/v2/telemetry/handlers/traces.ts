import type { Request, Response } from "express";
import { serviceNameFor } from "@/api/v2/telemetry/handlers/metrics";
import { forwardTraces } from "@/api/v2/telemetry/services/trace-forwarder";
import {
  applyServerResourceAttributes,
  sanitizeTraces,
} from "@/api/v2/telemetry/services/trace-sanitize";
import { ENV } from "@/config";
import { countTelemetryBatch } from "@/utils/metrics";

export async function postTraces(req: Request, res: Response) {
  // Resolve attribution up front so every terminal path — including the early
  // invalid-body rejection — increments convos_backend.telemetry.batches_received
  // by client, matching the metrics route's one-count-per-request invariant.
  // service.name comes from the verified App Check appId, never the client.
  const appId = res.locals.appCheckAppId as string | undefined;
  if (appId === undefined) {
    // App Check bypass — attribution defaults to convos-client; log so a
    // mislabeled `client` dimension is explainable.
    req.log.warn("telemetry.client_attribution_defaulted");
  }
  const client = serviceNameFor(appId);

  const body = req.body as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { resourceSpans?: unknown }).resourceSpans)
  ) {
    countTelemetryBatch(client, "rejected");
    res.status(400).json({ error: "Invalid OTLP traces body" });
    return;
  }

  const { droppedSpanNames } = sanitizeTraces(body);
  if (droppedSpanNames.length > 0) {
    // The span-name allowlist is a deliberate APM-cardinality guard; log the
    // dropped names so the telemetry loss is observable, not silent.
    req.log.warn(
      { client, droppedSpanNames },
      "telemetry.trace_spans_dropped_unknown_name",
    );
  }

  // deployment.environment / service.name are authoritative server-side, applied
  // AFTER sanitize so the resource-attr allowlist can't strip the values we set.
  applyServerResourceAttributes(body, {
    serviceName: client,
    environment: ENV,
  });

  const result = await forwardTraces(body);
  if (!result.ok) {
    // Both the permanent (agent 4xx → 400) and transient (agent 5xx/network →
    // 502) cases are forwarding failures, not client-input rejections.
    countTelemetryBatch(client, "forward_failed");
    if (result.permanent) {
      // The agent rejected the payload (4xx) — retrying can't fix it. Respond
      // 4xx so the client DROPS the batch instead of wedging its queue head.
      res.status(400).json({ error: "Telemetry trace batch rejected" });
      return;
    }
    // Transient failure (agent 5xx / network) — the client should retry.
    res.status(502).json({ error: "Telemetry trace forwarding failed" });
    return;
  }
  countTelemetryBatch(client, "accepted");
  res.status(202).json({ status: "accepted" });
}
