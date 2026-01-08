import { Router, type Request, type Response } from "express";
import { createNotificationClient } from "../notifications/client";
import { prisma } from "../utils/prisma";

const router = Router();

// GET /healthcheck - Healthcheck endpoint
router.get("/", (_req: Request, res: Response): void => {
  res.status(200).send("OK");
});

// GET /healthcheck/details - Enhanced healthcheck endpoint with detailed service status
router.get("/details", async (req: Request, res: Response): Promise<void> => {
  const checks = {
    status: "OK",
    timestamp: new Date().toISOString(),
    services: {
      database: { status: "unknown", error: null as string | null },
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

  // Check notification service connectivity
  try {
    createNotificationClient();
    // We can't easily test the notification client without making a real call,
    // so we just verify it was created successfully
    checks.services.notifications.status = "healthy";
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
});

export default router;
