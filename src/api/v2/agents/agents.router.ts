import { Router } from "express";
import { joinHandler } from "./handlers/join";
import { joinStatusHandler } from "./handlers/join-status";

export const agentsRouter = Router();

agentsRouter.post("/join", joinHandler);
agentsRouter.get("/join/:instanceId", joinStatusHandler);
