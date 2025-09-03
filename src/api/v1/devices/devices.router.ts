import { Router } from "express";
import { createDeviceHandler } from "./handlers/create-device.handler";
import { getDeviceHandler } from "./handlers/get-device.handler";
import { listDevicesHandler } from "./handlers/list-devices.handler";
import { updateDeviceHandler } from "./handlers/update-device.handler";

const devicesRouter = Router();

// GET /devices/:deviceId - Get a single device by ID
devicesRouter.get("/:deviceId", getDeviceHandler);

// GET /devices - Get all devices for the authenticated identity
devicesRouter.get("/", listDevicesHandler);

// POST /devices - Create a new device for the authenticated identity
devicesRouter.post("/", createDeviceHandler);

// PATCH /devices/:deviceId - Update a device for the authenticated identity
devicesRouter.patch("/:deviceId", updateDeviceHandler);

export default devicesRouter;
