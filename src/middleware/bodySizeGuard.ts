import type { RequestHandler } from "express";

// Reject requests whose Content-Length exceeds `limit` (bytes) before any body
// parsing, so oversized payloads are an early abort rather than a buffered
// rejection. Mount BEFORE the JSON body parser.
export const bodySizeGuard =
  (limit: number): RequestHandler =>
  (req, res, next) => {
    const len = Number(req.header("content-length") ?? 0);
    if (len > limit) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }
    next();
  };
