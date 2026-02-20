import { Router } from "express";
import { joinHandler } from "./handlers/join";

export const agentsRouter = Router();

agentsRouter.post("/join", joinHandler);
