import { Router } from "express";
import appConfigRouter from "@/api/v1/appConfig";
import authenticateRouter from "@/api/v1/authenticate";
import metadataRouter from "@/api/v1/metadata";
import notificationsRouter from "@/api/v1/notifications";
import profilesRouter from "@/api/v1/profiles/profiles.router";
import { authMiddleware } from "@/middleware/auth";
import attachmentsRouter from "./attachments";
import devicesRouter from "./devices";
import identitiesRouter from "./identities";
import lookupRouter from "./lookup";
import usersRouter from "./users/users.router";

const v1Router = Router();

// mount app config routes under /app-config
v1Router.use("/app-config", appConfigRouter);

// mount authenticate routes under /authenticate
v1Router.use("/authenticate", authenticateRouter);

// mount user routes under /users
v1Router.use("/users", authMiddleware, usersRouter);

// mount device routes under /devices
v1Router.use("/devices", authMiddleware, devicesRouter);

// mount identity routes under /identities
v1Router.use("/identities", authMiddleware, identitiesRouter);

// mount profile routes under /profiles
v1Router.use("/profiles", authMiddleware, profilesRouter);

// mount metadata routes under /metadata
v1Router.use("/metadata", authMiddleware, metadataRouter);

// mount lookup routes under /lookup
v1Router.use("/lookup", authMiddleware, lookupRouter);

// mount attachments routes under /attachments
v1Router.use("/attachments", authMiddleware, attachmentsRouter);

// mount notifications routes under /notifications
v1Router.use("/notifications", authMiddleware, notificationsRouter);

export default v1Router;
