import { Router } from "express";
import { appCheckOnlyMiddleware } from "@/middleware/auth";
import { authRateLimitMiddleware } from "@/middleware/rateLimit";
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
