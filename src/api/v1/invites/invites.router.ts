import { Router } from "express";
import { acceptRequestToJoin } from "./handlers/accept-request-to-join";
import { createInviteCode } from "./handlers/create-invite-code";
import { deleteInvite } from "./handlers/delete-invite";
import { deleteRequestToJoin } from "./handlers/delete-request-to-join";
import {
  getAuthenticatedInviteDetailsHandler,
  getOwnerInviteDetailsHandler,
} from "./handlers/get-invite-details";
import { getInviteRequests } from "./handlers/get-invite-requests";
import { requestToJoin } from "./handlers/request-to-join";
import { updateInviteCode } from "./handlers/update-invite-code";

const invitesRouter = Router();

invitesRouter.post("/", createInviteCode);
invitesRouter.post("/request", requestToJoin);
invitesRouter.get("/requests", getInviteRequests);
invitesRouter.put("/requests/:requestId/accept", acceptRequestToJoin);
invitesRouter.delete("/requests/:requestId", deleteRequestToJoin);
invitesRouter.put("/:inviteId", updateInviteCode);
invitesRouter.get(
  "/:inviteId/with-group",
  getAuthenticatedInviteDetailsHandler,
);
invitesRouter.get("/:inviteId", getOwnerInviteDetailsHandler);
invitesRouter.delete("/:inviteId", deleteInvite);

export default invitesRouter;
