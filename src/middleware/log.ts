import type { NextFunction, Request, Response } from "express";

const environment = process.env.ENV || "dev";

export const logMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (environment === "dev") {
    res.on("finish", () => {
      const statusCode = res.statusCode;
      const statusHighlight =
        statusCode >= 400 ? `[ERROR ${statusCode}]` : `[Status: ${statusCode}]`;

      const logBody =
        statusCode >= 400
          ? {
              url: req.originalUrl,
              method: req.method,
              body: req.body || {},
              query: req.query || {},
              params: req.params || {},
            }
          : undefined;

      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${statusHighlight}`,
      );

      if (logBody) {
        console.log(`Request details:`, JSON.stringify(logBody, null, 2));
      }
    });
  }
  next();
};
