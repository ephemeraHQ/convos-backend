import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import apiRouter from "./api";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { jsonMiddleware } from "./middleware/json";
import { noRouteMiddleware } from "./middleware/noRoute";
import { pinoMiddleware } from "./middleware/pino";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import { createNotificationClient } from "./notifications/client";
import logger from "./utils/logger";
import { prisma } from "./utils/prisma";
import { testXmtpConnection } from "./utils/xmtp";

const app = express();

// The application may be behind a reverse proxy
// and will need to trust the X-Forwarded-For header to get the client
// IP address
app.set("trust proxy", 1);
app.use(helmet()); // Set security headers
app.use(cors()); // Handle CORS
app.use(jsonMiddleware); // Parse JSON requests
app.use(pinoMiddleware);

// Rate limiting should be before routes but after logging
app.use(rateLimitMiddleware);

// GET /healthcheck - Healthcheck endpoint
app.get("/healthcheck", (_req: Request, res: Response): void => {
  res.status(200).send("OK");
});

// GET /healthcheck/details - Enhanced healthcheck endpoint with detailed service status
app.get(
  "/healthcheck/details",
  async (req: Request, res: Response): Promise<void> => {
    const checks = {
      status: "OK",
      timestamp: new Date().toISOString(),
      services: {
        database: { status: "unknown", error: null as string | null },
        xmtp: {
          status: "unknown",
          error: null as string | null,
          environment: null as string | null,
          inboxId: null as string | null,
          customHost: null as string | null,
        },
        notifications: { status: "unknown", error: null as string | null },
      },
    };

    let overallStatus = 200;

    // Check database connectivity
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.services.database.status = "healthy";
    } catch (error) {
      checks.services.database.status = "unhealthy";
      checks.services.database.error =
        error instanceof Error ? error.message : "Unknown database error";
      overallStatus = 503;
    }

    // Check XMTP connectivity
    const xmtpHealth = await testXmtpConnection();
    if (xmtpHealth.healthy) {
      checks.services.xmtp.status = "healthy";
      checks.services.xmtp.environment = xmtpHealth.environment || null;
      checks.services.xmtp.inboxId = xmtpHealth.inboxId || null;
      checks.services.xmtp.customHost = xmtpHealth.customHost || null;
    } else {
      checks.services.xmtp.status = "unhealthy";
      checks.services.xmtp.error = xmtpHealth.error || "Unknown XMTP error";
      checks.services.xmtp.environment = xmtpHealth.environment || null;
      checks.services.xmtp.customHost = xmtpHealth.customHost || null;
      overallStatus = 503;
      logger.error("XMTP health check failed:", xmtpHealth.error);
    }

    // Check notification service connectivity (optional, only if configured)
    try {
      if (process.env.NOTIFICATION_SERVER_URL) {
        const notificationClient = createNotificationClient();
        // We can't easily test the notification client without making a real call,
        // so we just verify it was created successfully
        checks.services.notifications.status = "healthy";
      } else {
        checks.services.notifications.status = "not_configured";
      }
    } catch (error) {
      checks.services.notifications.status = "unhealthy";
      checks.services.notifications.error =
        error instanceof Error ? error.message : "Unknown notification error";
    }

    // Update overall status
    if (overallStatus !== 200) {
      checks.status = "DEGRADED";
    }

    res.status(overallStatus).json(checks);
  },
);

// add api routes
app.use("/api", apiRouter);

// handle non-existent routes with 404 response
app.use(noRouteMiddleware);

// Error handling middleware should be last
app.use(errorHandlerMiddleware);

const port = process.env.PORT || 4000;
const server = app.listen(port, () => {
  logger.info(`Convos API service is running on port ${port}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received: closing Convos API service");
  server.close(() => {
    logger.info("Convos API service closed");
  });
});
