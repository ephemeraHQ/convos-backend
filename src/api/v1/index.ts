import { Router } from "express";
import metadataRouter from "@/api/v1/metadata";
import profilesRouter from "@/api/v1/profiles";
import devicesRouter from "./devices";
import identitiesRouter from "./identities";
import usersRouter from "./users";

const v1Router = Router();

// mount user routes under /users
v1Router.use("/users", usersRouter);

// mount device routes under /devices
v1Router.use("/devices", devicesRouter);

// mount identity routes under /identities
v1Router.use("/identities", identitiesRouter);

// mount profile routes under /profiles
v1Router.use("/profiles", profilesRouter);

// mount metadata routes under /metadata
v1Router.use("/metadata", metadataRouter);

export default v1Router;
