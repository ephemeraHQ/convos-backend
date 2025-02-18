import { Router } from "express";
import metadataRouter from "@/api/v1/metadata";
import profilesRouter from "@/api/v1/profiles/profiles.router";
import attachmentsRouter from "./attachments";
import devicesRouter from "./devices";
import identitiesRouter from "./identities";
import lookupRouter from "./lookup";
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

// mount lookup routes under /lookup
v1Router.use("/lookup", lookupRouter);

// mount attachments routes under /attachments
v1Router.use("/attachments", attachmentsRouter);

export default v1Router;
