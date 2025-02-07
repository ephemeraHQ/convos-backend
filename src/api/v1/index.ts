import { Router } from "express";
import usersRouter from "./users";

const v1Router = Router();

// mount user routes under /users
v1Router.use("/users", usersRouter);

export default v1Router;
