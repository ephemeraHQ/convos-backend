import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRequest, buildCreditsAdminApp } from "./helpers";

type WhoamiResponse = {
  ok: boolean;
  actorEmail: string;
  creditsPerUsd: number;
};

describe("GET /api/v2/credits-admin/whoami", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("401 without bearer token", async () => {
    const res = await adminRequest(app, false).get(
      "/api/v2/credits-admin/whoami",
    );
    expect(res.status).toBe(401);
  });

  it("200 with token: returns ok, actorEmail sentinel, creditsPerUsd", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/whoami");
    expect(res.status).toBe(200);
    const body = res.body as WhoamiResponse;
    expect(body.ok).toBe(true);
    // No CF perimeter in tests → sentinel identity.
    expect(body.actorEmail).toBe("token-admin@no-cf");
    expect(typeof body.creditsPerUsd).toBe("number");
    expect(body.creditsPerUsd).toBeGreaterThan(0);
  });
});
