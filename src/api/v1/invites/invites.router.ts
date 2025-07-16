import { Router } from "express";
import { createInviteCode } from "./handlers/create-invite-code";

const invitesRouter = Router();

invitesRouter.post("/", createInviteCode);

export default invitesRouter;
