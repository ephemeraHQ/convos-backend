import { Router } from "express";
import { checkUsername } from "./handlers/check-username";
import { getBatchProfiles } from "./handlers/get-batch-profiles";
import { getProfile } from "./handlers/get-profile";
import { searchProfiles } from "./handlers/search-profiles";
import { updateProfile } from "./handlers/update-profile";

const profilesRouter = Router();

// Define all routes
profilesRouter.get("/search", searchProfiles);
profilesRouter.get("/check/:username", checkUsername);
profilesRouter.post("/batch", getBatchProfiles);
profilesRouter.get("/:xmtpId", getProfile);
profilesRouter.put("/:xmtpId", updateProfile);

export default profilesRouter;
