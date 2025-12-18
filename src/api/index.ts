import { Router } from "express";
import v2Router from "./v2";

const apiRouter = Router();

apiRouter.use("/v2", v2Router);

export default apiRouter;
