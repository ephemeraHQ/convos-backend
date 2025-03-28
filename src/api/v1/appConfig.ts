import { Router } from "express";

const appConfigRouter = Router();

appConfigRouter.get("/", (req, res) => {
  res.json({ minimumAppVersion: { ios: "1.0.0", android: "1.0.0" } });
});

export default appConfigRouter;
