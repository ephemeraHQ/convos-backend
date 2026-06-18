import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRequest, buildCreditsAdminApp } from "./helpers";

describe("credits-admin page", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("serves the shell without auth (public page)", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("does NOT server-render any actor identity", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.text).not.toContain("Cf-Access-Authenticated-User-Email");
    expect(res.text).not.toContain("(Cloudflare Access)");
    expect(res.text).not.toMatch(/var ADMIN_EMAIL\s*=/);
  });

  it("sends Bearer (not cookies) and exposes a clear-token control", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.text).toContain("Authorization");
    expect(res.text).toContain("Bearer ");
    expect(res.text).not.toContain('credentials: "include"');
    expect(res.text).toContain('id="clear-token"');
  });
});
