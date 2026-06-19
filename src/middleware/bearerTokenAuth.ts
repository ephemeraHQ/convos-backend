import { timingSafeEqual } from "crypto";
import type { RequestHandler } from "express";

/**
 * Build a timing-safe bearer-token gate bound to a named env var. The secret
 * must be present and >= 32 chars or the gate 500s (fail closed). Accepts the
 * token raw or with a `Bearer ` prefix.
 */
export const makeBearerTokenAuth = (envVarName: string): RequestHandler => {
  return (req, res, next) => {
    const expectedToken = process.env[envVarName]?.trim();
    if (!expectedToken || expectedToken.length < 32) {
      req.log.error(
        `${envVarName} not configured or too short (min 32 chars) - rejecting request`,
      );
      res.status(500).json({ error: "Server configuration error" });
      return;
    }

    const authHeader = req.headers.authorization?.trim() ?? "";
    if (authHeader.length === 0) {
      req.log.error("Missing bearer auth authorization header");
      res
        .status(401)
        .json({ error: "Unauthorized: Missing authentication token" });
      return;
    }

    const providedToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();
    if (providedToken.length === 0) {
      req.log.error("Empty bearer auth token");
      res
        .status(401)
        .json({ error: "Unauthorized: Invalid authentication token" });
      return;
    }

    const provided = Buffer.from(providedToken, "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    const valid =
      provided.length === expected.length &&
      timingSafeEqual(provided, expected);
    if (!valid) {
      req.log.error("Invalid bearer auth authorization token");
      res
        .status(401)
        .json({ error: "Unauthorized: Invalid authentication token" });
      return;
    }

    next();
  };
};
