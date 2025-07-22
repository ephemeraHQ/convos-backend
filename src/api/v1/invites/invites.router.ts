import { Router } from "express";
import { createInviteCode } from "./handlers/create-invite-code";
import { getInviteRequests } from "./handlers/get-invite-requests";
import { requestToJoin } from "./handlers/request-to-join";

const invitesRouter = Router();

invitesRouter.post("/", createInviteCode);
invitesRouter.post("/request", requestToJoin);
invitesRouter.get("/requests", getInviteRequests);

export default invitesRouter;
