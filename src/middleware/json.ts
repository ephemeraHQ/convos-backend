import express, { type RequestHandler } from "express";

export const jsonMiddleware = express.json({ limit: "50mb" });

// Route prefixes that own their body parsing (with stricter caps) and must be
// skipped by the global 50mb parser — otherwise it buffers/parses the body
// first and the route-level limit never applies. Add new self-parsing routes
// here, and mount their own parser in the route's router.
const SELF_PARSING_PREFIXES = ["/api/v2/telemetry"];

export const globalJsonMiddleware: RequestHandler = (req, res, next) => {
  if (SELF_PARSING_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }
  jsonMiddleware(req, res, next);
};
