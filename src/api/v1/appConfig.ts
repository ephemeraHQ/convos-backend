import { Router } from "express";

const appConfigRouter = Router();

appConfigRouter.get("/", (req, res) => {
  res.json({
    minimumAppVersion: {
      ios: "1.0.0", // TODO: Change after CSX release
      android: "1.0.0", // TODO: Change after CSX release
      // ios: { version: "1.0.0", buildNumber: "1" },
      // android: { version: "1.0.0", buildNumber: "1" },
    },
  });
});

export default appConfigRouter;
