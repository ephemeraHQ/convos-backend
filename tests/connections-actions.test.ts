import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import { actionsGetHandler } from "@/api/v2/connections/handlers/actions-get";
import {
  __setComposioExecApiKeyOverrideForTests,
  COMPOSIO_EXEC_API_KEY_HEADER,
  composioExecAuth,
} from "@/middleware/agentAuth";
import { pinoMiddleware } from "@/middleware/pino";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const EXEC_KEY = "x".repeat(40);

// The action slugs Composio's live catalog exposes for googlecalendar. The
// endpoint serves exactly this set (sorted) — it is sourced from Composio, not
// our consent bundles, so a real-but-unbundled slug appears here too.
const STUB_GOOGLECALENDAR_CATALOG_SLUGS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_UPDATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_CALENDARS_DELETE",
];

function installComposioStub(catalogSlugs = STUB_GOOGLECALENDAR_CATALOG_SLUGS) {
  const stub = {
    tools: {
      getRawComposioTools: (query: { toolkits?: string[] }) => {
        const toolkit = (query.toolkits ?? [])[0]?.toLowerCase();
        const slugs = toolkit === "googlecalendar" ? catalogSlugs : [];
        return Promise.resolve(slugs.map((slug) => ({ slug })));
      },
    },
  };
  __resetComposioServiceForTests(
    new ComposioService({
      composio: stub as unknown as ConstructorParameters<
        typeof ComposioService
      >[0]["composio"],
    }),
  );
}

// Mirrors the production wiring: auth MIRRORS /v2/composio/exec
// (composioExecAuth / X-Composio-Exec-Key) so the trusted worker reaches this
// with the same credential it forwards exec under — NOT a per-user JWT.
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.get(
    "/connections/services/:toolkit/actions",
    composioExecAuth,
    actionsGetHandler,
  );
  return app;
}

type ActionsResponse = {
  toolkit: string;
  composioSlug: string;
  version: number;
  actions: string[];
};

function getActions(toolkit: string, opts: { key?: string | null } = {}) {
  const key = opts.key === undefined ? EXEC_KEY : opts.key;
  const req = request(makeApp()).get(
    `/connections/services/${toolkit}/actions`,
  );
  return key ? req.set(COMPOSIO_EXEC_API_KEY_HEADER, key) : req;
}

beforeAll(() => {
  __setComposioExecApiKeyOverrideForTests(EXEC_KEY);
});

afterAll(() => {
  __setComposioExecApiKeyOverrideForTests(undefined);
  __resetComposioServiceForTests(null);
});

afterEach(() => {
  __resetComposioServiceForTests(null);
});

describe("GET /v2/connections/services/:toolkit/actions (no DB)", () => {
  test("401 without the exec key", async () => {
    installComposioStub();
    const res = await getActions("googlecalendar", { key: null });
    expect(res.status).toBe(401);
  });

  test("401 with a wrong exec key", async () => {
    installComposioStub();
    const res = await getActions("googlecalendar", { key: "wrong".repeat(10) });
    expect(res.status).toBe(401);
  });

  test("200 with the exec key (parity with /exec auth)", async () => {
    installComposioStub();
    const res = await getActions("googlecalendar");
    expect(res.status).toBe(200);
  });

  test("returns the toolkit's live catalog slug vocabulary", async () => {
    installComposioStub();
    const res = await getActions("googlecalendar");
    expect(res.status).toBe(200);

    const body = res.body as ActionsResponse;
    expect(body.toolkit).toBe("googlecalendar");
    expect(body.composioSlug).toBe("googlecalendar");
    expect(typeof body.version).toBe("number");
    expect(body.actions).toEqual(
      expect.arrayContaining([
        "GOOGLECALENDAR_EVENTS_LIST",
        "GOOGLECALENDAR_CREATE_EVENT",
        "GOOGLECALENDAR_UPDATE_EVENT",
        "GOOGLECALENDAR_DELETE_EVENT",
      ]),
    );
    // A real Composio slug we have NOT bundled is still part of the catalog
    // vocabulary the endpoint serves (validity is sourced from Composio, not
    // our consent bundles).
    expect(body.actions).toContain("GOOGLECALENDAR_CALENDARS_DELETE");
    // The slugs the agent guessed during the loop are not real Composio slugs,
    // so they must NOT appear — this is exactly what local validation rejects.
    expect(body.actions).not.toContain("GOOGLECALENDAR_LIST_EVENTS");
    expect(body.actions).not.toContain("listEvents");
    expect(body.actions).not.toContain("calendar.events.list");
  });

  test("case-insensitive toolkit match", async () => {
    installComposioStub();
    const res = await getActions("GoogleCalendar");
    expect(res.status).toBe(200);
    expect((res.body as ActionsResponse).toolkit).toBe("googlecalendar");
  });

  test("404 for an unknown toolkit", async () => {
    installComposioStub();
    const res = await getActions("notaservice");
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("unknown_toolkit");
  });

  test("sets a private cache header", async () => {
    installComposioStub();
    const res = await getActions("googlecalendar");
    expect(res.headers["cache-control"]).toContain("private");
  });
});
