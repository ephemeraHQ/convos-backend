import { Router } from "express";
import { createInviteCode } from "./handlers/create-invite-code";
import { getInviteDetailsHandler } from "./handlers/get-invite-details";

const invitesRouter = Router();

invitesRouter.post("/", createInviteCode);
invitesRouter.get("/:inviteId", getInviteDetailsHandler);

export default invitesRouter;
