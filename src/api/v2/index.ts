import { Router } from "express";
import invitesV2Router from "./invites/invites.router";

const v2Router = Router();

v2Router.use("/invites", invitesV2Router);

export default v2Router;
