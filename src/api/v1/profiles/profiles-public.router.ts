import { Router } from "express";
import { getPublicProfile } from "./handlers/get-public-profile";

const publicProfilesRouter = Router();

// Define public routes
publicProfilesRouter.get("/:username", getPublicProfile);

export default publicProfilesRouter;
