import { Router } from "express";
import { renewBatchHandler } from "./handlers/renew-batch";

export const assetsRouter = Router();

assetsRouter.post("/renew-batch", renewBatchHandler);
