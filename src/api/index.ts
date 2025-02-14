import { Router } from "express";
import { authMiddleware } from "@/middleware/auth";
import v1Router from "./v1";

const apiRouter = Router();

apiRouter.use(authMiddleware);

// add v1 api
apiRouter.use("/v1", v1Router);

export default apiRouter;
