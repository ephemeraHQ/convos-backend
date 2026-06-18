import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRequest, buildCreditsAdminApp } from "./helpers";

describe("credits-admin mount", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("router is mounted (unknown path under mount → 404 from noRoute, not a crash)", async () => {
    const res = await adminRequest(app).get(
      "/api/v2/credits-admin/does-not-exist",
    );
    expect(res.status).toBe(404);
  });
});
