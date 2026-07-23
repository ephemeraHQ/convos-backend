import { Router } from "express";
import { abilitiesListHandler } from "./handlers/list";

// /v2/abilities — the Connections V2 ability surface. Auth is applied at the
// mount point in src/api/v2/index.ts (authMiddleware, deliberately without
// requireAccount — see the list handler's contract).
export const abilitiesRouter = Router();

abilitiesRouter.get("/", abilitiesListHandler);
