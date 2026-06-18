import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRequest, buildCreditsAdminApp } from "./helpers";

describe("GET /api/v2/credits-admin/ (admin page)", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("serves HTML with CSP nonce, no-store, noindex, and echoes the CF Access identity", async () => {
    const res = await adminRequest(app, "ops@convos.test").get(
      "/api/v2/credits-admin/",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const csp = res.headers["content-security-policy"];
    expect(csp).toMatch(/script-src 'nonce-/);
    const text = res.text;
    expect(text).toContain('content="noindex, nofollow"');
    expect(text).toContain("ops@convos.test");
    const headerNonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(headerNonce).toBeTruthy();
    expect(text).toContain(`<script nonce="${headerNonce}">`);
  });

  it("page route does NOT require the CF Access header (perimeter gates it)", async () => {
    const res = await adminRequest(app, null).get("/api/v2/credits-admin/");
    expect(res.status).toBe(200);
  });

  it("escapes angle brackets in the injected identity (no <script> breakout)", async () => {
    const res = await adminRequest(app, "evil</script><script>x").get(
      "/api/v2/credits-admin/",
    );
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("evil</script>");
    expect(res.text).toContain("evil\\u003c/script\\u003e");
  });
});
