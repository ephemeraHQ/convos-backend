import { Router } from "express";
import { decodeInviteSlugHandler } from "./handlers/decode-invite-slug";

const invitesV2Router = Router();

invitesV2Router.get("/:slug", decodeInviteSlugHandler);

export default invitesV2Router;
