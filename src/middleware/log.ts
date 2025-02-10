import type { NextFunction, Request, Response } from "express";

const environment = process.env.ENV || "dev";

export const logMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  if (environment === "dev") {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`,
    );
  }
  next();
};
