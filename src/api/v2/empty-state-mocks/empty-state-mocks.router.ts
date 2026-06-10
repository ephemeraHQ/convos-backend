import { Router } from "express";
import { EMPTY_STATE_MOCKS } from "./empty-state-mocks.data";

export const emptyStateMocksRouter = Router();

// Public and unauthenticated: this is onboarding mock data for brand-new
// installs that have no account or JWT yet. The payload is static per
// deploy, so it is cacheable; clients keep their bundled copy whenever
// this endpoint is unreachable or returns an unexpected shape.
emptyStateMocksRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(EMPTY_STATE_MOCKS);
});
