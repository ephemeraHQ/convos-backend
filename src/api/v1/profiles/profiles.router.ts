import { Router } from "express";
import { checkUsername } from "./handlers/check-username";
import { createProfile } from "./handlers/create-profile";
import { getProfile } from "./handlers/get-profile";
import { searchProfiles } from "./handlers/search-profiles";
import { updateProfile } from "./handlers/update-profile";

const profilesRouter = Router();

// Define all routes
profilesRouter.get("/search", searchProfiles);
profilesRouter.get("/check/:username", checkUsername);
profilesRouter.get("/:xmtpId", getProfile);
profilesRouter.post("/:xmtpId", createProfile);
profilesRouter.put("/:xmtpId", updateProfile);

export default profilesRouter;
