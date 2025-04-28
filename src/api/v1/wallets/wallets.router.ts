import { Router } from "express";
import { createSubOrg } from "./handlers/create-suborg";

const walletsRouter = Router();

walletsRouter.post("/", createSubOrg);

export default walletsRouter;
