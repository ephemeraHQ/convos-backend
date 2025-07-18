import { Router } from "express";
import { getInviteDetailsHandler } from "./handlers/get-invite-details";

const publicInvitesRouter = Router();

publicInvitesRouter.get("/:inviteId", getInviteDetailsHandler);

export default publicInvitesRouter;
