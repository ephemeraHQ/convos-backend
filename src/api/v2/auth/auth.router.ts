import { Router } from "express";
import { APPCHECK_HEADER, authV2Middleware } from "@/middleware/v2/auth";
import { generateToken } from "./handlers/generate-token";

const authRouter = Router();

// Token generation requires AppCheck (main app only)
authRouter.post("/token", async (req, res, next) => {
  const appCheckToken = req.header(APPCHECK_HEADER);
  if (!appCheckToken) {
    res.status(401).json({ error: "AppCheck required for token generation" });
    return;
  }
  await authV2Middleware(req, res, next);
}, generateToken);

export { authRouter };
