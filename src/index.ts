import os from "node:os";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import {
  startTtlSweep as startGenerationTtlSweep,
  stopTtlSweep as stopGenerationTtlSweep,
} from "@/api/v2/agent-templates/services/ttl-sweep";
import apiRouter from "./api";
import { IS_DEVELOPMENT, XMTP_ENV } from "./config";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { jsonMiddleware } from "./middleware/json";
import { noRouteMiddleware } from "./middleware/noRoute";
import { pinoMiddleware } from "./middleware/pino";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import healthcheckRouter from "./routes/healthcheck";
import { wellKnownRouter } from "./routes/well-known";
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
app.use(jsonMiddleware); // Parse JSON requests
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

      // Generation pipeline sweep — only when the agent-templates router is
      // mounted (gated on XMTP_ENV !== "production"; see src/api/v2/index.ts).
      if (XMTP_ENV !== "production") {
        startGenerationTtlSweep();
      }
    });

    process.on("SIGTERM", () => {
      logger.info("SIGTERM signal received: closing Convos API service");
      // Stop the generation TTL sweep so its setInterval doesn't keep
      // dispatching DB queries against a closing pool during the drain
      // window. No-op if the sweep was never started (production gate).
      stopGenerationTtlSweep();
      server.close(() => {
        logger.info("Convos API service closed");
      });
    });
  })
  .catch((error: unknown) => {
    logger.error({ error }, "Failed to validate JWT keys at startup");
    process.exit(1);
  });
