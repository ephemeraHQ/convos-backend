import os from "node:os";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import {
  startDeletionOutboxSweep,
  stopDeletionOutboxSweep,
} from "@/accounts/deletion/outbox";
import { shutdownPostHog } from "@/api/v2/agent-templates/services/posthog";
import {
  startTtlSweep as startGenerationTtlSweep,
  stopTtlSweep as stopGenerationTtlSweep,
} from "@/api/v2/agent-templates/services/ttl-sweep";
import { runComposioUserIdMigrationOnce } from "@/api/v2/connections/migrate-user-ids";
import {
  startTelemetryTtlSweep,
  stopTelemetryTtlSweep,
} from "@/api/v2/telemetry/services/ttl-sweep";
import apiRouter from "./api";
import { IS_DEVELOPMENT, TELEMETRY_MAX_BODY_BYTES } from "./config";
import { bodySizeGuard } from "./middleware/bodySizeGuard";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { globalJsonMiddleware } from "./middleware/json";
import { noRouteMiddleware } from "./middleware/noRoute";
import { pinoMiddleware } from "./middleware/pino";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import healthcheckRouter from "./routes/healthcheck";
import { wellKnownRouter } from "./routes/well-known";
import { assertAppleRootCertsPresent } from "./subscriptions/jws-verifier";
import { validateJWTKeys } from "./utils/jwt";
import logger from "./utils/logger";

const getLocalIpAddresses = () => {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  Object.values(interfaces).forEach((networkInterface) => {
    networkInterface?.forEach((details) => {
      if (details.family === "IPv4" && !details.internal) {
        addresses.push(details.address);
      }
    });
  });

  return addresses;
};

const app = express();

// The application may be behind a reverse proxy
// and will need to trust the X-Forwarded-For header to get the client
// IP address
app.set("trust proxy", 1);
app.use(helmet()); // Set security headers
app.use(cors()); // Handle CORS
// Reject oversized telemetry batches before any JSON parser buffers them.
// Path-scoped so it only fires for telemetry routes; the telemetry router
// re-applies the same guard as a backstop.
app.use("/api/v2/telemetry", bodySizeGuard(TELEMETRY_MAX_BODY_BYTES));
// Skips routes that own their body parsing (see SELF_PARSING_PREFIXES).
app.use(globalJsonMiddleware);
app.use(cookieParser()); // Parse cookies (required for SIWE nonce flow)
app.use(pinoMiddleware);

// Rate limiting should be before routes but after logging
app.use(rateLimitMiddleware);

// add healthcheck routes
app.use("/healthcheck", healthcheckRouter);

// .well-known proxied from assistant runtime service (RFC 8615 – must be at domain root)
app.use("/.well-known", wellKnownRouter);

// add api routes
app.use("/api", apiRouter);

// handle non-existent routes with 404 response
app.use(noRouteMiddleware);

// Error handling middleware should be last
app.use(errorHandlerMiddleware);

const port = process.env.PORT || 4000;

// Fail fast at boot if the Apple root CA certs didn't ship with the bundle.
// These are read from dist/certs at runtime (copied there by tsup's onSuccess
// hook). If the asset pipeline regresses, refuse to start rather than coming
// up "healthy" and 500ing lazily on the first Apple verify / S2S request —
// which is what previously masked a missing-cert bug as a signature error.
try {
  assertAppleRootCertsPresent();
  logger.info("Apple root CA certs present");
} catch (error) {
  logger.error(
    { error },
    "Apple root CA certs missing from bundle — refusing to start",
  );
  process.exit(1);
}

// Validate JWT keys at startup before starting the server
validateJWTKeys()
  .then(() => {
    logger.info("JWT key validation successful");

    const server = app.listen(port, () => {
      logger.info(`Convos API service is running on port ${port}`);

      if (IS_DEVELOPMENT) {
        const localIps = getLocalIpAddresses();
        logger.info(`Available at: http://localhost:${port}`);
        localIps.forEach((ip) => {
          logger.info(`Available at: http://${ip}:${port}`);
        });
      }

      // Generation pipeline sweep — expires stale generation rows. Runs in
      // every env now that the agent-templates router is mounted everywhere.
      startGenerationTtlSweep();
      // Telemetry dedup sweep — trims dedup rows past their retention window.
      startTelemetryTtlSweep();
      // Account-deletion outbox drain — executes external purges (S3,
      // notification server, Composio, PostHog) queued by the deletion
      // transaction, with retries, SLA alerting, and record expiry.
      startDeletionOutboxSweep();

      // One-time data migration: move Composio connections from deviceId to the
      // stable accountId. Self-guards via a RuntimeConfig ledger marker so it
      // runs exactly once per environment (like a DB migration) and is a no-op
      // on every subsequent boot. Fired after listen so a slow/failing external
      // call never blocks startup or health checks.
      void runComposioUserIdMigrationOnce();
    });

    // Wrap the async drain steps in a void-IIFE so the SIGTERM listener
    // itself returns void (Node ignores the listener's return value, and
    // an `async` listener would trip @typescript-eslint/no-misused-promises).
    // `shutdownPostHog()` catches its own errors, so the IIFE never rejects.
    process.on("SIGTERM", () => {
      void (async () => {
        logger.info("SIGTERM signal received: closing Convos API service");
        // Stop the generation TTL sweep so its setInterval doesn't keep
        // dispatching DB queries against a closing pool during the drain
        // window. No-op if the sweep was never started.
        stopGenerationTtlSweep();
        stopTelemetryTtlSweep();
        stopDeletionOutboxSweep();
        // Flush buffered PostHog events before the process exits. The SDK
        // buffers up to flushAt (default 20) or flushInterval (default 10s)
        // — without an explicit shutdown, low-volume captures get dropped
        // on every redeploy. Catches its own errors; never throws.
        await shutdownPostHog();
        server.close(() => {
          logger.info("Convos API service closed");
        });
      })();
    });
  })
  .catch((error: unknown) => {
    logger.error({ error }, "Failed to validate JWT keys at startup");
    process.exit(1);
  });
