import express, { Router, type ErrorRequestHandler } from "express";
import { TELEMETRY_MAX_BODY_BYTES } from "@/config";
import { bodySizeGuard } from "@/middleware/bodySizeGuard";
import { countTelemetryBatch } from "@/utils/metrics";
import { postMetrics, serviceNameFor } from "./handlers/metrics";

// Parse the telemetry body here (after the size guard) with the telemetry
// cap, so this route does not depend on the global 50mb JSON parser and the
// size guard always runs first. `limit` is a hard backstop if Content-Length
// is absent or lies.
const parseTelemetryBody = express.json({ limit: TELEMETRY_MAX_BODY_BYTES });

// Count client-error rejections that happen before postMetrics runs —
// malformed JSON (400) and parser-enforced oversize (413) — so they show up
// in batches_received like handler-level rejections do. Server errors (5xx)
// pass through uncounted; they aren't client rejections. App Check 401s and
// honest-Content-Length 413s are handled before this router and stay out of
// this metric by design.
const countParseRejections: ErrorRequestHandler = (err, req, res, next) => {
  const status =
    (err as { statusCode?: unknown }).statusCode ??
    (err as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    countTelemetryBatch(
      serviceNameFor(res.locals.appCheckAppId as string | undefined),
      "rejected",
    );
  }
  next(err);
};

const telemetryRouter = Router();
telemetryRouter.post(
  "/metrics",
  bodySizeGuard(TELEMETRY_MAX_BODY_BYTES),
  parseTelemetryBody,
  postMetrics,
);
telemetryRouter.use(countParseRejections);

export { telemetryRouter };
