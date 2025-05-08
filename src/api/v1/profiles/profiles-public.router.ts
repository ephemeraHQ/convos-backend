import { Router } from "express";
import { getPublicProfile } from "./handlers/get-public-profile";

const publicProfilesRouter = Router();

// Define public routes
publicProfilesRouter.get("/username/:username", getPublicProfile);
publicProfilesRouter.get("/xmtpId/:xmtpId", getPublicProfile);
publicProfilesRouter.get("/:username", getPublicProfile);

export default publicProfilesRouter;
