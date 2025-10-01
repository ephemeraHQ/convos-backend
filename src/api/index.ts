import { Router } from "express";
import v1Router from "./v1";
import v2Router from "./v2";

const apiRouter = Router();

// add v1 api
apiRouter.use("/v1", v1Router);

// add v2 api
apiRouter.use("/v2", v2Router);

export default apiRouter;
