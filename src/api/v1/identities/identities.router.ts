import { Router } from "express";
import { createIdentityWithDevice } from "./handlers/create-identity-with-device";
import { getDeviceIdentities } from "./handlers/get-device-identities";
import { getIdentity } from "./handlers/get-identity";
import { getUserIdentities } from "./handlers/get-user-identities";
import { linkDeviceToIdentity } from "./handlers/link-device-to-identity";
import { unlinkDeviceFromIdentity } from "./handlers/unlink-device-from-identity";
import { updateIdentity } from "./handlers/update-identity";

const identitiesRouter = Router();

identitiesRouter.get("/device/:deviceId", getDeviceIdentities);
identitiesRouter.get("/user/:userId", getUserIdentities);
identitiesRouter.get("/:identityId", getIdentity);
identitiesRouter.post("/device/:deviceId", createIdentityWithDevice);
identitiesRouter.put("/:identityId", updateIdentity);
identitiesRouter.post("/:identityId/link", linkDeviceToIdentity);
identitiesRouter.delete("/:identityId/link", unlinkDeviceFromIdentity);

export default identitiesRouter;
