import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRequest, buildCreditsAdminApp } from "./helpers";

describe("credits-admin page (console shell)", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  const get = () => adminRequest(app, false).get("/api/v2/credits-admin/");

  it("serves HTML without server auth", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("is auth-first: login present, console present but hidden", async () => {
    const res = await get();
    expect(res.text).toContain('id="login"');
    expect(res.text).toContain('id="console"');
    // console starts hidden until whoami succeeds
    expect(res.text).toMatch(/id="console"[^>]*class="[^"]*hidden/);
  });

  it("shell is data-free: no identity, token, or creditsPerUsd inlined", async () => {
    const res = await get();
    expect(res.text).not.toContain("Cf-Access-Authenticated-User-Email");
    expect(res.text).not.toContain("(Cloudflare Access)");
    expect(res.text).not.toMatch(/var ADMIN_EMAIL\s*=/);
    // The real pricing constant (creditsPerDollar ≥ 1) must NOT be inlined — it
    // comes from whoami now. The script's placeholder init `= null` is fine; only
    // an actual inlined number (leading 1-9) is a violation.
    expect(res.text).not.toMatch(/var CREDITS_PER_USD\s*=\s*[1-9]/);
  });

  it("wires bearer auth + whoami + guardFetch, no cookies", async () => {
    const res = await get();
    expect(res.text).toContain("Authorization");
    expect(res.text).toContain("Bearer ");
    expect(res.text).toContain("/whoami");
    expect(res.text).toContain("guardFetch");
    expect(res.text).not.toContain('credentials: "include"');
    expect(res.text).toContain('id="lock"');
  });

  it("wires the activity list, facets, and load-more to audit/recent", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.text).toContain("/audit/recent");
    expect(res.text).toContain("load-more");
    expect(res.text).toContain('data-action="grant"');
    expect(res.text).toContain("/search?"); // search routes to /search, not audit/recent
  });

  it("wires the detail panel: account view, grant, adjust, sub-state chip", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.text).toContain("/grant");
    expect(res.text).toContain("/adjust");
    expect(res.text).toContain("badge-none"); // sub-state chip (none/entitled/lapsed)
    expect(res.text).toContain("usage-spark");
    expect(res.text).toContain("perPeriodCredits");
  });

  it("wires the accounts view selector + modes + /accounts endpoint", async () => {
    const res = await adminRequest(app, false).get("/api/v2/credits-admin/");
    expect(res.text).toContain('id="view-mode"');
    // the URL is built by concatenation ("/accounts" + "?mode=" + ...); assert the
    // rendered literals, not the runtime-concatenated whole.
    expect(res.text).toContain('guardFetch("/accounts"');
    expect(res.text).toContain('"?mode="');
    expect(res.text).toContain('value="balance"');
    expect(res.text).toContain('value="broken"');
    expect(res.text).toContain('value="grantKind"');
    expect(res.text).toContain('id="accounts-table"');
    expect(res.text).toContain("loadAccounts");
  });
});
