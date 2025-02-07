import { Router } from "express";
import devicesRouter from "./devices";
import usersRouter from "./users";

const v1Router = Router();

// mount user routes under /users
v1Router.use("/users", usersRouter);

// mount device routes under /devices
v1Router.use("/devices", devicesRouter);

export default v1Router;
