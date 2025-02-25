import { Router } from "express";

const appConfigRouter = Router();

appConfigRouter.get("/", (req, res) => {
  res.json({ minimumAppVersion: { ios: "2.2.29", android: "2.2.29" } });
});

export default appConfigRouter;
