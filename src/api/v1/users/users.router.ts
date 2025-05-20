import { Router } from "express";
import { createUser } from "./handlers/create-user";
import { getCurrentUser } from "./handlers/get-current-user";

const usersRouter = Router();

usersRouter.get("/me", getCurrentUser);
usersRouter.post("/", createUser);

export default usersRouter;
