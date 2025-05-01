import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import apiRouter from "./api";
import { errorHandlerMiddleware } from "./middleware/errorHandler";
import { jsonMiddleware } from "./middleware/json";
import { noRouteMiddleware } from "./middleware/noRoute";
import { pinoMiddleware } from "./middleware/pino";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import logger from "./utils/logger";

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
