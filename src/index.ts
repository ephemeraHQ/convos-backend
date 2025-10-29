import os from "node:os";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import apiRouter from "./api";
import { IS_DEVELOPMENT } from "./config";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { jsonMiddleware } from "./middleware/json";
import { noRouteMiddleware } from "./middleware/noRoute";
import { pinoMiddleware } from "./middleware/pino";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import healthcheckRouter from "./routes/healthcheck";
import logger from "./utils/logger";
import { validateJWTKeys } from "./utils/v2/jwt";

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
app.use(pinoMiddleware);

// Rate limiting should be before routes but after logging
app.use(rateLimitMiddleware);

// add healthcheck routes
app.use("/healthcheck", healthcheckRouter);

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
    });

    process.on("SIGTERM", () => {
      logger.info("SIGTERM signal received: closing Convos API service");
      server.close(() => {
        logger.info("Convos API service closed");
      });
    });
  })
  .catch((error: unknown) => {
    logger.error("Failed to validate JWT keys at startup", error);
    process.exit(1);
  });
