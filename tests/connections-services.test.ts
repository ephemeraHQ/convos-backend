import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { servicesGetHandler } from "@/api/v2/connections/handlers/services-get";
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
  app.get("/connections/services", authMiddleware, servicesGetHandler);
  return app;
}

type ServicesResponse = {
  services: Array<{
    id: string;
    composioSlug: string;
    version: number;
    displayName: { en: string };
    bundles: Array<{
      id: string;
      title: { en: string };
      description: { en: string };
      defaultEnabled: boolean;
    }>;
  }>;
};

beforeAll(async () => {
  await validateJWTKeys();
});

describe("GET /v2/connections/services (no DB)", () => {
  test("401 without a JWT", async () => {
    const res = await request(makeApp()).get("/connections/services");
    expect(res.status).toBe(401);
  });

  test("200 with a device-only JWT (no requireAccount)", async () => {
    // A device-only token carries no accountId; the catalog is not account
    // scoped, so it must still succeed — this guards the wiring decision.
    const token = await createJwtToken({ deviceId: "dev-catalog" });
    const res = await request(makeApp())
      .get("/connections/services")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
  });

  test("response shape matches the contract and strips slugs", async () => {
    const token = await createJwtToken({ deviceId: "dev-catalog" });
    const res = await request(makeApp())
      .get("/connections/services")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);

    const body = res.body as ServicesResponse;
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services.length).toBeGreaterThan(0);

    const gcal = body.services.find((s) => s.id === "googlecalendar");
    expect(gcal).toBeDefined();
    expect(gcal!.id).toBe("googlecalendar");
    expect(gcal!.composioSlug).toBe("googlecalendar");
    expect(typeof gcal!.version).toBe("number");
    expect(gcal!.displayName.en).toBe("Google Calendar");
    expect(gcal!.bundles.length).toBeGreaterThan(0);
    for (const b of gcal!.bundles) {
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

    // No Composio action slug may leak into the served payload.
    expect(JSON.stringify(body)).not.toMatch(/GOOGLECALENDAR_/);
    expect(JSON.stringify(body)).not.toMatch(/GMAIL_/);
    expect(JSON.stringify(body)).not.toMatch(/composioActions/);
  });

  test("googlecalendar offers a single 'Events' bundle — deprecated read bundle hidden", async () => {
    // Product decision: ONE picker toggle for calendar (read+write). The
    // retired calendar.events.read id stays exec-resolvable internally but
    // must never be offered to clients again.
    const token = await createJwtToken({ deviceId: "dev-catalog" });
    const res = await request(makeApp())
      .get("/connections/services")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);

    const body = res.body as ServicesResponse;
    const gcal = body.services.find((s) => s.id === "googlecalendar");
    expect(gcal).toBeDefined();
    expect(gcal!.version).toBeGreaterThanOrEqual(4);
    expect(gcal!.bundles).toHaveLength(1);
    expect(gcal!.bundles[0].id).toBe("calendar.events");
    expect(gcal!.bundles[0].title.en).toBe("Events");
    expect(gcal!.bundles[0].description.en).toBe(
      "View and edit events on all calendars",
    );
    expect(JSON.stringify(body)).not.toContain("calendar.events.read");
    expect(JSON.stringify(body)).not.toContain("deprecated");
  });

  test("sets a private cache header", async () => {
    const token = await createJwtToken({ deviceId: "dev-catalog" });
    const res = await request(makeApp())
      .get("/connections/services")
      .set("X-Convos-AuthToken", token);
    expect(res.headers["cache-control"]).toContain("private");
  });
});
