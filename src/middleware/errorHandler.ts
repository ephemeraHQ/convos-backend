import type express from "express";
import { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { IS_DEVELOPMENT } from "@/config";
import logger from "@/utils/logger";
import { AppError } from "../utils/errors";

// Express requires error handling middleware to have exactly 4 parameters
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // Rename 'next' to '_next' to satisfy the linter while keeping the 4 params Express needs
  _next: NextFunction,
) {
  // Log the error with request context. `req.log` is typed as always-present,
  // but pino-http only attaches it once its middleware runs — errors thrown
  // earlier (e.g. body-parser rejecting malformed JSON) reach this handler with
  // `req.log` undefined. Fall back to the base logger so logging here can't
  // itself throw and collapse the response into a raw HTML 500.
  const log = (req as { log?: typeof logger }).log ?? logger;
  log.error(err);

  // If response is already sent, just log the error and return
  if (res.headersSent) {
    return;
  }

  // Handle known error types
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation Error",
      details: err.errors,
    });
  }

  // body-parser and friends attach an HTTP status to their errors (e.g. 413
  // entity.too.large, 400 entity.parse.failed). Honor 4xx so client mistakes
  // aren't reported as server 500s; 5xx still falls through to the generic
  // handler below.
  const errStatus =
    (err as { statusCode?: unknown }).statusCode ??
    (err as { status?: unknown }).status;
  if (typeof errStatus === "number" && errStatus >= 400 && errStatus < 500) {
    return res.status(errStatus).json({ error: err.message });
  }

  // Handle unknown errors
  return res.status(500).json({
    error: "Internal Server Error",
    ...(IS_DEVELOPMENT && {
      message: err.message,
    }),
  });
}

// Add this type assertion to fix the error
export const errorHandlerMiddleware =
  errorHandler as express.ErrorRequestHandler;
