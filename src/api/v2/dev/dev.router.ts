import { Router } from "express";
import {
  getRuntimeConfig,
  setRuntimeConfig,
} from "@/utils/runtimeConfig";

const devRouter = Router();

devRouter.get("/app-attest", async (req, res) => {
  const value = await getRuntimeConfig("app_attest_enabled", "true");
  res.json({ enabled: value === "true" });
});

devRouter.post("/app-attest", async (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "Request body must include 'enabled' (boolean)" });
    return;
  }

  await setRuntimeConfig("app_attest_enabled", String(enabled));
  req.log.info({ enabled }, "App Attest toggled via dev endpoint");
  res.json({ enabled });
});

export { devRouter };
