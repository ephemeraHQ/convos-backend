import { Router } from "express";
import { completeHandler } from "./handlers/complete";
import { deleteHandler } from "./handlers/delete";
import { grantsDeleteHandler } from "./handlers/grants-delete";
import { grantsListHandler } from "./handlers/grants-list";
import { grantsPostHandler } from "./handlers/grants-post";
import { initiateHandler } from "./handlers/initiate";
import { listHandler } from "./handlers/list";

export const connectionsRouter = Router();

connectionsRouter.post("/initiate", initiateHandler);
connectionsRouter.post("/complete", completeHandler);

// Capability grants: iOS issues/lists/revokes consent records that the
// backend's POST /v2/composio/exec reads to authorize agent tool calls.
// Declared before "/:id" so "/grants" is never swallowed by the param route.
connectionsRouter.post("/grants", grantsPostHandler);
connectionsRouter.get("/grants", grantsListHandler);
connectionsRouter.delete("/grants/:id", grantsDeleteHandler);

connectionsRouter.get("/", listHandler);
connectionsRouter.delete("/:id", deleteHandler);
