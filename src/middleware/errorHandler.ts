import type express from "express";
import { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { AppError, logError } from "../utils/errors";

// Express requires error handling middleware to have exactly 4 parameters
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // Rename 'next' to '_next' to satisfy the linter while keeping the 4 params Express needs
  _next: NextFunction,
) {
  // Log the error with request context
  logError(err, {
    path: req.path,
    method: req.method,
    body: req.body,
    query: req.query,
    params: req.params,
  });

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

  // Extract useful error information
  const errorDetails = {
    message: err.message,
    name: err.name,
    stack: err.stack,
    // Include additional properties from the error object
    ...(err instanceof Error &&
      Object.getOwnPropertyNames(err)
        .filter((key) => key !== "stack" && key !== "message" && key !== "name")
        .reduce<Record<string, unknown>>((acc, key) => {
          // @ts-expect-error - dynamic property access
          acc[key] = err[key];
          return acc;
        }, {})),
  };

  // Handle unknown errors - always include detailed info now
  return res.status(500).json({
    error: "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && {
      message: err.message,
      details: errorDetails,
    }),
  });
}

// Add this type assertion to fix the error
export const errorHandlerMiddleware =
  errorHandler as express.ErrorRequestHandler;
