import { Router } from "express";
import v1Router from "./v1";

const apiRouter = Router();

// TODO: add app check middleware

// add v1 api
apiRouter.use("/v1", v1Router);

export default apiRouter;
