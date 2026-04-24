import { Router } from "express";
import { completeHandler } from "./handlers/complete";
import { deleteHandler } from "./handlers/delete";
import { initiateHandler } from "./handlers/initiate";
import { listHandler } from "./handlers/list";

export const connectionsRouter = Router();

connectionsRouter.post("/initiate", initiateHandler);
connectionsRouter.post("/complete", completeHandler);
connectionsRouter.get("/", listHandler);
connectionsRouter.delete("/:id", deleteHandler);
