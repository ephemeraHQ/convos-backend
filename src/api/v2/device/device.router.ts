import { Router } from "express";
import { register } from "./handlers/register";

const deviceRouter = Router();

// Device management routes
// All routes require auth (AppCheck or JWT) - applied at mount point in v2/index.ts
deviceRouter.post("/register", register);

export { deviceRouter };
