import { Router } from "express";
import {
  agentJoinLimiter,
  agentJoinStatusLimiter,
} from "@/middleware/rateLimit";
import { joinHandler } from "./handlers/join";
import { joinStatusHandler } from "./handlers/join-status";

export const agentsRouter = Router();

// Tight limit on provisioning (10/5min) — each call kicks off an expensive
// upstream container-boot workflow.
agentsRouter.post("/join", agentJoinLimiter, joinHandler);
// Generous limit on status polling (60/5min) — clients on the fallback
// async path may poll every ~5s; status reads have no upstream side-effects.
agentsRouter.get(
  "/join/:instanceId",
  agentJoinStatusLimiter,
  joinStatusHandler,
);
