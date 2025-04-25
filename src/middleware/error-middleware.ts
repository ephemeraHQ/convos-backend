import {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ZodError } from "zod";
import { AppError, logError } from "../utils/errors";

// Express requires error handling middleware to have exactly 4 parameters
export const errorMiddleware = ((
  err: Error,
  req: Request,
  res: Response,
  // Rename 'next' to '_next' to satisfy the linter while keeping the 4 params Express needs
  _next: NextFunction,
) => {
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

  // Handle unknown errors
  return res.status(500).json({
    error: "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && {
      message: err.message,
    }),
  });
}) as ErrorRequestHandler;
