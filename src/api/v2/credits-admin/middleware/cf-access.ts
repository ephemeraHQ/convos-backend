import type { NextFunction, Request, Response } from "express";
import { IS_DEVELOPMENT } from "@/config";

export const CF_ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";
export const CF_ACCESS_DEV_FALLBACK_EMAIL = "local-dev@convos.invalid";

let _devFallbackOverride: boolean | undefined = undefined;
export function __setCfAccessDevFallbackForTests(
  value: boolean | undefined,
): void {
  _devFallbackOverride = value;
}
function devFallbackEnabled(): boolean {
  return _devFallbackOverride ?? IS_DEVELOPMENT;
}

type ResolvedActor =
  | { email: string; usedDevFallback: boolean }
  | { email: null; usedDevFallback: false };

export function resolveActorEmail(
  headerValue: string | undefined,
): ResolvedActor {
  const trimmed = (headerValue ?? "").trim();
  if (trimmed) {
    return { email: trimmed, usedDevFallback: false };
  }
  if (devFallbackEnabled()) {
    return { email: CF_ACCESS_DEV_FALLBACK_EMAIL, usedDevFallback: true };
  }
  return { email: null, usedDevFallback: false };
}

export const cfAccessHeaderMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const resolved = resolveActorEmail(req.header(CF_ACCESS_EMAIL_HEADER));
  if (!resolved.email) {
    req.log.warn("cf_access.missing_header");
    res.status(401).json({ code: "unauthorized" });
    return;
  }
  if (resolved.usedDevFallback) {
    req.log.warn("cf_access.dev_fallback_identity");
  }
  res.locals.actorEmail = resolved.email;
  next();
};
