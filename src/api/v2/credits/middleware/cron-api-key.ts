import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

const MIN_CRON_API_KEY_LENGTH = 32;

let _cronApiKeyOverride: string | null | undefined = undefined;

function getCronApiKey(): string {
  if (_cronApiKeyOverride !== undefined) {
    return (_cronApiKeyOverride ?? "").trim();
  }
  return (process.env.PAYMENTS_CRON_API_KEY ?? "").trim();
}

/** Override `PAYMENTS_CRON_API_KEY` for tests.
 *  - Pass a string to override.
 *  - Pass `null` to simulate "key unset" (forces 503).
 *  - Pass `undefined` to clear the override and fall back to env. */
export function __setCronApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _cronApiKeyOverride = key;
}

function constantTimeSecretCompare(
  provided: string,
  expected: string,
): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function maskKeyPrefix(key: string): string {
  if (key.length === 0) return "(empty)";
  return `${key.slice(0, 4)}... (len=${key.length})`;
}

export const requireCronApiKey = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const expectedKey = getCronApiKey();

  if (!expectedKey) {
    req.log.error("cron_api_key.not_configured");
    res.status(503).json({ error: "Cron API key not configured" });
    return;
  }
  if (expectedKey.length < MIN_CRON_API_KEY_LENGTH) {
    req.log.error(
      { keyLength: expectedKey.length },
      "cron_api_key.config_invalid",
    );
    res.status(503).json({ error: "Cron API key misconfigured" });
    return;
  }

  const provided = (req.headers["x-cron-api-key"] as string | undefined) ?? "";
  if (!provided || !constantTimeSecretCompare(provided, expectedKey)) {
    req.log.warn(
      { providedPrefix: maskKeyPrefix(provided) },
      "cron_api_key.unauthorized",
    );
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
};
