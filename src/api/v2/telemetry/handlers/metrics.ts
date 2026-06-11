import type { Request, Response } from "express";
import { releaseBatch, tryClaimBatch } from "@/api/v2/telemetry/services/dedup";
import { forwardMetrics } from "@/api/v2/telemetry/services/forwarder";
import { prepareBatch } from "@/api/v2/telemetry/services/otlp";
import { ENV } from "@/config";
import { ValidationError } from "@/utils/errors";
import { countTelemetryBatch } from "@/utils/metrics";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `X-Sent-At` is the client's wall-clock at upload time, used to correct clock
// skew. Accept either an ISO-8601 date string or an integer epoch timestamp in
// milliseconds or nanoseconds (>=1e15 is treated as nanos), so a client can't
// get the format subtly wrong. Returns epoch ms, or null if unparseable.
const parseSentAtMs = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    // Heuristic: epoch ms is ~1.7e12 now; ns is ~1.7e18. Split at 1e15.
    return n >= 1e15 ? Math.floor(n / 1e6) : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

// App Check appIds follow the format `1:<project-number>:<platform>:<hash>`.
// Unknown platforms (including web or future additions) fall through to
// "convos-client".
const serviceNameFor = (appId: string | undefined): string => {
  if (appId?.includes(":ios:")) return "convos-ios";
  if (appId?.includes(":android:")) return "convos-android";
  return "convos-client";
};

export async function postMetrics(req: Request, res: Response) {
  // Tag our own batches_received counter with the client app this bundle
  // came from (verified App Check appId, not client-supplied).
  const client = serviceNameFor(res.locals.appCheckAppId as string | undefined);

  const batchId = req.header("Idempotency-Key");
  if (!batchId || !UUID_RE.test(batchId)) {
    countTelemetryBatch(client, "rejected");
    res.status(400).json({ error: "Missing or invalid Idempotency-Key" });
    return;
  }
  const sentAtMs = parseSentAtMs(req.header("X-Sent-At"));
  if (sentAtMs === null) {
    countTelemetryBatch(client, "rejected");
    res.status(400).json({ error: "Missing or invalid X-Sent-At" });
    return;
  }

  // Claim the batch id up front — the INSERT is the duplicate gate, so two
  // concurrent requests with the same Idempotency-Key cannot both forward.
  if (!(await tryClaimBatch(batchId))) {
    countTelemetryBatch(client, "duplicate");
    res.status(202).json({ status: "duplicate" });
    return;
  }

  // Only an accepted batch keeps the claim; any other outcome releases it so
  // the client's retry with the same Idempotency-Key isn't dropped as a dup.
  let accepted = false;
  try {
    const receivedAtMs = Date.now();
    let prepared;
    try {
      prepared = prepareBatch(req.body, {
        offsetMs: receivedAtMs - sentAtMs,
        receivedAtMs,
        serviceName: client,
        environment: ENV,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        countTelemetryBatch(client, "rejected");
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }

    if (prepared.droppedStalePoints > 0) {
      req.log.info(
        { count: prepared.droppedStalePoints, batchId },
        "telemetry.points_dropped_stale",
      );
    }
    if (prepared.strippedAttrKeys.length > 0) {
      req.log.warn(
        { keys: prepared.strippedAttrKeys, batchId },
        "telemetry.resource_attrs_stripped",
      );
    }

    if (!prepared.isEmpty) {
      const ok = await forwardMetrics(prepared.body);
      if (!ok) {
        countTelemetryBatch(client, "forward_failed");
        res.status(502).json({ error: "Telemetry forwarding failed" });
        return;
      }
    }

    accepted = true;
    countTelemetryBatch(client, "accepted");
    res.status(202).json({ status: "accepted" });
  } finally {
    if (!accepted) {
      await releaseBatch(batchId);
    }
  }
}
