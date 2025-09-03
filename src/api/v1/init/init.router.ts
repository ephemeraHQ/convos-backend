import { Router } from "express";
import { init } from "./handlers/init";

const initRouter = Router();

initRouter.post("/", init);

export default initRouter;
