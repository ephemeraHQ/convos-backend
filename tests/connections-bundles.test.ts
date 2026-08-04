import { describe, expect, test } from "vitest";
import {
  getPublicServiceConfigs,
  getServiceConfig,
  resolveBundleActions,
  SERVICE_CONFIGS,
  toPublicServiceConfig,
} from "@/api/v2/connections/bundles.config";

// Pure catalog logic — no DB, no HTTP. Covers bundle → action resolution and
// the public (slug-stripped) view served by GET /v2/connections/services.

describe("bundles catalog — resolveBundleActions (no DB)", () => {
  test("resolves a known bundle to its action slugs", () => {
    const actions = resolveBundleActions("googlecalendar", ["calendar.events"]);
    expect(actions).toEqual(
      expect.arrayContaining([
        "GOOGLECALENDAR_EVENTS_LIST",
        "GOOGLECALENDAR_CREATE_EVENT",
        "GOOGLECALENDAR_UPDATE_EVENT",
        "GOOGLECALENDAR_DELETE_EVENT",
      ]),
    );
  });

  test("service id match is case-insensitive", () => {
    expect(resolveBundleActions("GoogleCalendar", ["calendar.events"])).toEqual(
      resolveBundleActions("googlecalendar", ["calendar.events"]),
    );
  });

  test("unknown service contributes nothing", () => {
    expect(resolveBundleActions("notaservice", ["calendar.events"])).toEqual(
      [],
    );
  });

  test("unknown bundle id contributes nothing (stale grant ⇒ no actions)", () => {
    expect(resolveBundleActions("googlecalendar", ["calendar.bogus"])).toEqual(
      [],
    );
  });

  test("empty bundleIds resolves to no actions", () => {
    expect(resolveBundleActions("googlecalendar", [])).toEqual([]);
  });

  test("union dedupes across overlapping bundles", () => {
    // Passing the same bundle twice must not duplicate actions.
    const once = resolveBundleActions("googlecalendar", ["calendar.events"]);
    const twice = resolveBundleActions("googlecalendar", [
      "calendar.events",
      "calendar.events",
    ]);
    expect(new Set(twice)).toEqual(new Set(once));
  });

  test("calendar.events.read resolves to read-only slugs — no write verbs", () => {
    const actions = resolveBundleActions("googlecalendar", [
      "calendar.events.read",
    ]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).toContain("GOOGLECALENDAR_EVENTS_LIST");
    // The scoping invariant: a read bundle must never carry a mutating slug.
    for (const a of actions) {
      expect(a).not.toMatch(/CREATE|UPDATE|DELETE|PATCH/);
    }
  });

  test("mail.read resolves to exactly the three fetch slugs — read-only", () => {
    // The read-only launch invariant, pinned as an exact allow-list (a verb
    // heuristic would miss mutators like MARK or ARCHIVE and would not catch
    // a dropped fetch slug).
    const actions = [...resolveBundleActions("gmail", ["mail.read"])].sort();
    expect(actions).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    ]);
  });

  test("DEPRECATED bundles still resolve — legacy grants must keep working", () => {
    // calendar.events.read was retired from the public catalog in v4 but
    // real grants persist it; deprecation must never break exec resolution.
    const readBundle = getServiceConfig("googlecalendar")?.bundles.find(
      (b) => b.id === "calendar.events.read",
    );
    expect(readBundle?.deprecated).toBe(true);
    expect(
      resolveBundleActions("googlecalendar", ["calendar.events.read"]),
    ).toEqual(["GOOGLECALENDAR_EVENTS_LIST"]);
  });
});

describe("bundles catalog — getServiceConfig (no DB)", () => {
  test("returns the seeded googlecalendar service", () => {
    const svc = getServiceConfig("googlecalendar");
    expect(svc?.id).toBe("googlecalendar");
    expect(svc?.bundles.map((b) => b.id)).toContain("calendar.events");
    expect(svc?.bundles.map((b) => b.id)).toContain("calendar.events.read");
  });

  test("googlecalendar version was bumped for the single-bundle merge (contract: bump on ANY change)", () => {
    expect(getServiceConfig("googlecalendar")?.version).toBeGreaterThanOrEqual(
      4,
    );
  });

  test("returns undefined for an unknown service", () => {
    expect(getServiceConfig("notaservice")).toBeUndefined();
  });
});

describe("bundles catalog — public view strips slugs (no DB)", () => {
  test("toPublicServiceConfig drops composioActions from every bundle", () => {
    const svc = getServiceConfig("googlecalendar");
    expect(svc).toBeDefined();
    const pub = toPublicServiceConfig(svc!);
    for (const b of pub.bundles) {
      expect(b).not.toHaveProperty("composioActions");
      expect(Object.keys(b).sort()).toEqual([
        "defaultEnabled",
        "description",
        "id",
        "title",
      ]);
      expect(typeof b.id).toBe("string");
      expect(typeof b.title.en).toBe("string");
      expect(typeof b.description.en).toBe("string");
      expect(typeof b.defaultEnabled).toBe("boolean");
    }
  });

  test("getPublicServiceConfigs serializes with no slug anywhere", () => {
    const json = JSON.stringify(getPublicServiceConfigs());
    // No Composio action slug should survive into the public payload.
    expect(json).not.toMatch(/GOOGLECALENDAR_/);
    expect(json).not.toMatch(/GMAIL_/);
    expect(json).not.toMatch(/composioActions/);
  });

  test("public service keeps id/composioSlug/version/displayName", () => {
    const [svc] = getPublicServiceConfigs();
    expect(svc.id).toBe("googlecalendar");
    expect(svc.composioSlug).toBe("googlecalendar");
    expect(typeof svc.version).toBe("number");
    expect(svc.displayName.en).toBe("Google Calendar");
  });

  test("public catalog covers every seeded service", () => {
    expect(getPublicServiceConfigs()).toHaveLength(SERVICE_CONFIGS.length);
  });

  test("googlecalendar serves exactly ONE bundle: 'Events'", () => {
    // Product decision (2026-06-12): a single user-facing toggle covering
    // read+write. The read-only sibling is deprecated and must not be offered.
    // Copy per the Figma design: row title "Events", subtitle (description)
    // "View and edit events on all calendars".
    const gcal = getPublicServiceConfigs().find(
      (s) => s.id === "googlecalendar",
    );
    expect(gcal).toBeDefined();
    expect(gcal!.bundles).toHaveLength(1);
    expect(gcal!.bundles[0].id).toBe("calendar.events");
    expect(gcal!.bundles[0].title.en).toBe("Events");
    expect(gcal!.bundles[0].description.en).toBe(
      "View and edit events on all calendars",
    );
  });

  test("gmail serves exactly ONE bundle: the read-only 'Emails'", () => {
    // Read-only launch: one on-by-default toggle covering fetch actions only;
    // a write bundle is a deliberate later addition.
    const gmail = getPublicServiceConfigs().find((s) => s.id === "gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.composioSlug).toBe("gmail");
    expect(gmail!.bundles).toHaveLength(1);
    expect(gmail!.bundles[0].id).toBe("mail.read");
    expect(gmail!.bundles[0].title.en).toBe("Emails");
    expect(gmail!.bundles[0].description.en).toBe(
      "Read and search emails in your inbox",
    );
    expect(gmail!.bundles[0].defaultEnabled).toBe(true);
  });

  test("deprecated bundles are excluded from the public view, and the flag never leaks", () => {
    const json = JSON.stringify(getPublicServiceConfigs());
    expect(json).not.toContain("calendar.events.read");
    expect(json).not.toContain("deprecated");
  });
});
