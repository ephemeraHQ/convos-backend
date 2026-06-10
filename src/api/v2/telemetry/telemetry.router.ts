import express, { Router } from "express";
import { TELEMETRY_MAX_BODY_BYTES } from "@/config";
import { bodySizeGuard } from "@/middleware/bodySizeGuard";
import { postMetrics } from "./handlers/metrics";

// Parse the telemetry body here (after the size guard) with the telemetry
// cap, so this route does not depend on the global 50mb JSON parser and the
// size guard always runs first. `limit` is a hard backstop if Content-Length
// is absent or lies.
const parseTelemetryBody = express.json({ limit: TELEMETRY_MAX_BODY_BYTES });

const telemetryRouter = Router();
telemetryRouter.post(
  "/metrics",
  bodySizeGuard(TELEMETRY_MAX_BODY_BYTES),
  parseTelemetryBody,
  postMetrics,
);

export { telemetryRouter };
