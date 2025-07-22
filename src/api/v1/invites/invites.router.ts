import { Router } from "express";
import { createInviteCode } from "./handlers/create-invite-code";
import { getAuthenticatedInviteDetailsHandler } from "./handlers/get-invite-details";
import { getInviteRequests } from "./handlers/get-invite-requests";
import { requestToJoin } from "./handlers/request-to-join";
import { updateInviteCode } from "./handlers/update-invite-code";

const invitesRouter = Router();

invitesRouter.post("/", createInviteCode);
invitesRouter.post("/request", requestToJoin);
invitesRouter.get("/requests", getInviteRequests);
invitesRouter.put("/:inviteId", updateInviteCode);
invitesRouter.get("/:inviteId", getAuthenticatedInviteDetailsHandler);

export default invitesRouter;
