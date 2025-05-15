import { Router } from "express";
import { createDeviceHandler } from "./handlers/create-device.handler";
import { getDeviceHandler } from "./handlers/get-device.handler";
import { listDevicesHandler } from "./handlers/list-devices.handler";
import { updateDeviceHandler } from "./handlers/update-device.handler";

const devicesRouter = Router();

// GET /devices/:userId/:deviceId - Get a single device by ID
devicesRouter.get("/:userId/:deviceId", getDeviceHandler);

// GET /devices/:userId - Get all devices for a user
devicesRouter.get("/:userId", listDevicesHandler);

// POST /devices/:userId - Create a new device
devicesRouter.post("/:userId", createDeviceHandler);

// PUT /devices/:userId/:deviceId - Update a device
devicesRouter.put("/:userId/:deviceId", updateDeviceHandler);

export default devicesRouter;
