import type { Request, Response } from "express";
import { config } from "@/payments/credits/config";

export const whoamiGetHandler = (_req: Request, res: Response): void => {
  // attachActorIdentity has set res.locals.actorEmail (verified CF email, or the
  // sentinel token-admin@no-cf when no CF perimeter).
  const actorEmail = res.locals.actorEmail ?? "";
  res.status(200).json({
    ok: true,
    actorEmail,
    creditsPerUsd: Number(config.creditsPerDollar),
  });
};
