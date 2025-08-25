import { Router } from "express";
import { getPublicInviteDetailsHandler } from "./handlers/get-invite-details";

const publicInvitesRouter = Router();

publicInvitesRouter.get("/:inviteId", getPublicInviteDetailsHandler);

export default publicInvitesRouter;
