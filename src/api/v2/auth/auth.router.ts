import { Router } from "express";
import { authV2Middleware } from "@/middleware/v2/auth";
import { generateToken } from "./handlers/generate-token";

const authRouter = Router();

// Token generation requires AppCheck (main app only)
authRouter.post("/token", authV2Middleware, generateToken);

export { authRouter };
