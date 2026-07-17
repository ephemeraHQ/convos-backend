import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { clientScript } from "@/api/v2/credits-admin/handlers/admin-page/script";
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
    expect(res.text).toContain("pill-none"); // sub-state chip (none/entitled/lapsed)
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
    // setView() hides the activity feed by this id. It used to walk
    // #activity-table.parentNode, which silently broke if the markup grew a
    // wrapper. Pin the id so a restyle can't reintroduce that coupling.
    expect(res.text).toContain('id="activity-wrap"');
    // setView() retitles this per view; pins the element's existence only —
    // the label swap itself is runtime behaviour a string assertion can't reach.
    expect(res.text).toContain('id="center-title"');
  });
});

describe("admin page — brand", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("uses the Lava brand token and drops the old navy token", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("--color-brand:#FC4F37");
    expect(res.text).not.toContain("#283a75");
    expect(res.text).not.toContain("💳");
  });

  it("renders the chat-bubble SVG mark and wordmark", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("M27.7736 13.8868");
    expect(res.text).toContain("Convos Credits");
  });

  it("uses .pill status classes, not legacy .badge", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("pill-none");
    expect(res.text).not.toContain('class="badge');
  });
});

describe("admin page — single search box", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("removes the search-key select and keeps a single search input", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).not.toContain('id="search-key"');
    expect(res.text).toContain('id="search-value"');
    expect(res.text).toContain('placeholder="Account ID or wallet address"');
  });
  it("renders view-mode as a custom brand dropdown over a hidden native select", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).not.toContain("select-wrap");
    expect(res.text).toContain('class="dd" data-dd="view-mode"');
    expect(res.text).toContain("dd-btn");
    expect(res.text).toContain('class="dd-native"');
    expect(res.text).toContain('role="listbox"');
    expect(res.text).toContain('class="chev"');
  });
});

describe("admin page — tables", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("no longer truncates account ids with shortId", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).not.toContain("function shortId");
    expect(res.text).not.toContain("slice(0,8)");
  });
  it("wires server-side sort params and a resize handle", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("sortBy=");
    expect(res.text).toContain("sortDir=");
    expect(res.text).toContain('"rz"');
  });
  it("broken view defines a Period end column", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("Period end");
  });
});

describe("admin page — centered detail modal", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("nests the detail dialog inside the scrim with dialog ARIA", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    const scrimIdx = res.text.indexOf('id="detail-scrim"');
    const detailIdx = res.text.indexOf('id="detail"');
    expect(scrimIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeGreaterThan(scrimIdx);
    expect(res.text).toContain('role="dialog"');
    expect(res.text).toContain('aria-modal="true"');
  });

  it("wires Esc-to-close and a scrim-target close guard", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain('e.key==="Escape"');
    expect(res.text).toContain("e.target===");
  });

  it("uses a centered modal, not a right slide-over transform", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("@keyframes pop");
    expect(res.text).not.toContain("translateX(102%)");
  });
});

describe("admin page — full history load-more", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("wires a paginated ledger endpoint fetch and seeds from ledgerNextCursor", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("/ledger");
    expect(res.text).toContain("ledgerNextCursor");
  });

  it("renders Load more controls and an empty-history note", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("Load more");
    expect(res.text).toContain("Nothing here yet");
  });

  it("defines the ledger + audit load-more functions", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("loadLedgerMore");
    expect(res.text).toContain("loadAuditMore");
  });

  it("guards load-more appends with a detail-generation counter", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("detailGen");
    // in-flight appends bail when the detail was re-rendered (e.g. after a grant)
    expect(res.text).toContain("gen!==detailGen");
  });
});

describe("admin page — balance table columns", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });

  it("balance view defines Wallet and Last activity columns", async () => {
    const res = await adminRequest(app).get("/api/v2/credits-admin/");
    expect(res.text).toContain("Wallet");
    expect(res.text).toContain("Last activity");
    expect(res.text).toContain("r.wallet");
    expect(res.text).toContain("r.lastConsumeAt");
  });
});

describe("admin client script — syntax", () => {
  it("clientScript() is syntactically valid JS", () => {
    // new Function parses the body without executing it — catches syntax errors
    // in the template-string JS that string assertions miss.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(clientScript())).not.toThrow();
  });
});

describe("admin page — ledger movements filter", () => {
  let app: Express;
  beforeAll(() => {
    app = buildCreditsAdminApp();
  });
  const get = () => adminRequest(app).get("/api/v2/credits-admin/");

  it("renames the card to Ledger movements and drops Recent ledger", async () => {
    const res = await get();
    expect(res.text).toContain("Ledger movements");
    expect(res.text).not.toContain("Recent ledger");
  });

  it("renders the Kind, Reason, date, and Clear filter controls", async () => {
    const res = await get();
    expect(res.text).toContain('id="d-lf-kind"');
    expect(res.text).toContain('id="d-lf-reason"');
    expect(res.text).toContain('id="d-lf-from"');
    expect(res.text).toContain('id="d-lf-to"');
    expect(res.text).toContain('id="d-lf-clear"');
    expect(res.text).toContain('value="subscription"');
    // dead refill value must never be offered as a filter
    expect(res.text).not.toContain('value="refill"');
  });

  it("defines the filter apply + query builder and carries the filter into load-more", async () => {
    const res = await get();
    expect(res.text).toContain("applyLedgerFilter");
    expect(res.text).toContain("buildLedgerQuery");
    // load-more must build its URL through buildLedgerQuery (filter carry-forward),
    // not the old cursor-only concatenation.
    expect(res.text).toContain("buildLedgerQuery(ledgerCursor)");
    expect(res.text).not.toContain(
      '/ledger?cursor="+encodeURIComponent(ledgerCursor)',
    );
    expect(res.text).toContain("No movements match this filter");
  });
});
