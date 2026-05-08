import { Router } from "express";
import { appCheckOnlyMiddleware } from "@/middleware/auth";
import { authRateLimitMiddleware } from "@/middleware/rateLimit";
import { generateNonce } from "./handlers/generate-nonce";
import { generateToken } from "./handlers/generate-token";

const authRouter = Router();

authRouter.post(
  "/nonce",
  authRateLimitMiddleware,
  appCheckOnlyMiddleware,
  generateNonce,
);

authRouter.post(
  "/token",
  authRateLimitMiddleware,
  appCheckOnlyMiddleware,
  generateToken,
);

export { authRouter };
