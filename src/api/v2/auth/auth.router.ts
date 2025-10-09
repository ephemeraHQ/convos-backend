import { Router } from "express";
import { authV2Middleware } from "@/middleware/v2/auth";
import { authRateLimitMiddleware } from "@/middleware/rateLimit";
import { generateToken } from "./handlers/generate-token";

const authRouter = Router();

// Token generation requires AppCheck (main app only) with strict rate limiting
authRouter.post(
  "/token",
  authRateLimitMiddleware,
  authV2Middleware,
  generateToken,
);

export { authRouter };
