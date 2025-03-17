import { Router } from "express";
import { rateLimitMiddleware } from "@/middleware/rateLimit";
import { getPublicProfile } from "./handlers/get-public-profile";

const publicProfilesRouter = Router();

// Define public routes
publicProfilesRouter.get("/:username", rateLimitMiddleware, getPublicProfile);

export default publicProfilesRouter;
