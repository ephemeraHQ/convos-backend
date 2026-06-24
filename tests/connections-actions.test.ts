import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { actionsGetHandler } from "@/api/v2/connections/handlers/actions-get";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Mirrors the production wiring: JWT-only (authMiddleware), NOT requireAccount.
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.get(
    "/connections/services/:toolkit/actions",
    authMiddleware,
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

beforeAll(async () => {
  await validateJWTKeys();
});

describe("GET /v2/connections/services/:toolkit/actions (no DB)", () => {
  test("401 without a JWT", async () => {
    const res = await request(makeApp()).get(
      "/connections/services/googlecalendar/actions",
    );
    expect(res.status).toBe(401);
  });

  test("200 with a device-only JWT (no requireAccount)", async () => {
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/googlecalendar/actions")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
  });

  test("returns the toolkit's full known-action slug vocabulary", async () => {
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/googlecalendar/actions")
      .set("X-Convos-AuthToken", token);
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
    // The slugs the agent guessed during the loop must NOT be present — these
    // are exactly what local validation should reject.
    expect(body.actions).not.toContain("GOOGLECALENDAR_LIST_EVENTS");
    expect(body.actions).not.toContain("listEvents");
    expect(body.actions).not.toContain("calendar.events.list");
  });

  test("includes deprecated-bundle slugs so old grants stay nameable", async () => {
    // calendar.events.read is deprecated but still resolvable at exec; its
    // slug (GOOGLECALENDAR_EVENTS_LIST) is already in calendar.events, so the
    // union is unaffected — assert it is present regardless.
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/googlecalendar/actions")
      .set("X-Convos-AuthToken", token);
    const body = res.body as ActionsResponse;
    expect(body.actions).toContain("GOOGLECALENDAR_EVENTS_LIST");
  });

  test("case-insensitive toolkit match", async () => {
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/GoogleCalendar/actions")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    expect((res.body as ActionsResponse).toolkit).toBe("googlecalendar");
  });

  test("404 for an unknown toolkit", async () => {
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/notaservice/actions")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("unknown_toolkit");
  });

  test("sets a private cache header", async () => {
    const token = await createJwtToken({ deviceId: "dev-actions" });
    const res = await request(makeApp())
      .get("/connections/services/googlecalendar/actions")
      .set("X-Convos-AuthToken", token);
    expect(res.headers["cache-control"]).toContain("private");
  });
});
