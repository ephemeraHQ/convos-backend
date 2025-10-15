import { Router } from "express";
import { authRateLimitMiddleware } from "@/middleware/rateLimit";
import { appCheckOnlyMiddleware } from "@/middleware/v2/auth";
import { generateToken } from "./handlers/generate-token";

const authRouter = Router();

// Token generation requires AppCheck only (main app only) with strict rate limiting
authRouter.post(
  "/token",
  authRateLimitMiddleware,
  appCheckOnlyMiddleware,
  generateToken,
);

export { authRouter };
