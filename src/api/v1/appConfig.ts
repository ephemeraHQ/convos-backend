import { Router } from "express";

const appConfigRouter = Router();

appConfigRouter.get("/", (req, res) => {
  res.json({ minimumAppVersion: { ios: "2.2.34", android: "2.2.34" } });
});

export default appConfigRouter;
