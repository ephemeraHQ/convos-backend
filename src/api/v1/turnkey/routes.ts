import { Router } from "express";
import { createSubOrg } from "./handlers/create-sub-org";
import { getSubOrgId } from "./handlers/get-sub-org";
import { oauthLogin } from "./handlers/oauth-login";
import type {
  CreateSubOrgParams,
  GetSubOrgIdParams,
  OAuthLoginParams,
} from "./types";

const router = Router();

// Passkey and OAuth authentication routes
router.post("/get-sub-org", getSubOrgId);
router.post("/create-sub-org", createSubOrg);
router.post("/oauth-login", oauthLogin);

export default router;
