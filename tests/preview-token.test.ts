import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import {
  PREVIEW_TOKEN_HEADER,
  previewTokenMiddleware,
} from "@/middleware/previewToken";

const VALID_TOKEN = "preview-token-that-is-at-least-32-characters-long";

// Mirrors the real mount order in src/index.ts: pino first (the gate logs
// through req.log), then the gate, then everything else.
const app = express();
app.use(pinoMiddleware);
app.use(previewTokenMiddleware);
app.use(jsonMiddleware);
app.get("/healthcheck", (_req, res) => {
  res.status(200).send("OK");
});
app.get("/healthcheck/details", (_req, res) => {
  res.status(200).json({ status: "OK" });
});
app.get("/api/v2/anything", (_req, res) => {
  res.status(200).json({ ok: true });
});

describe("previewTokenMiddleware", () => {
  let server: Server;
  const baseURL = "http://localhost:4096";
  const originalPreview = process.env.PREVIEW;
  const originalToken = process.env.PREVIEW_TOKEN;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4096, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (originalPreview === undefined) {
      delete process.env.PREVIEW;
    } else {
      process.env.PREVIEW = originalPreview;
    }
    if (originalToken === undefined) {
      delete process.env.PREVIEW_TOKEN;
    } else {
      process.env.PREVIEW_TOKEN = originalToken;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    process.env.PREVIEW = "1";
    process.env.PREVIEW_TOKEN = VALID_TOKEN;
  });

  afterEach(() => {
    delete process.env.PREVIEW;
    delete process.env.PREVIEW_TOKEN;
  });

  const get = (path: string, headers?: Record<string, string>) =>
    fetch(`${baseURL}${path}`, { method: "GET", headers: { ...headers } });

  // --- inert outside preview mode ---

  test("passes everything through when PREVIEW is unset", async () => {
    delete process.env.PREVIEW;
    const res = await get("/api/v2/anything");
    expect(res.status).toBe(200);
  });

  test('passes everything through when PREVIEW is not exactly "1"', async () => {
    process.env.PREVIEW = "true";
    const res = await get("/api/v2/anything");
    expect(res.status).toBe(200);
  });

  // --- the gate ---

  test("rejects a request with no token", async () => {
    const res = await get("/api/v2/anything");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Invalid or missing preview token",
    });
  });

  test("rejects a request with the wrong token", async () => {
    const res = await get("/api/v2/anything", {
      [PREVIEW_TOKEN_HEADER]: "wrong-token-that-is-also-32-characters-long",
    });
    expect(res.status).toBe(401);
  });

  test("accepts the correct token", async () => {
    const res = await get("/api/v2/anything", {
      [PREVIEW_TOKEN_HEADER]: VALID_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("accepts the header case-insensitively", async () => {
    const res = await get("/api/v2/anything", {
      "x-preview-token": VALID_TOKEN,
    });
    expect(res.status).toBe(200);
  });

  test("tolerates surrounding whitespace in the header value", async () => {
    const res = await get("/api/v2/anything", {
      [PREVIEW_TOKEN_HEADER]: ` ${VALID_TOKEN} `,
    });
    expect(res.status).toBe(200);
  });

  // --- exemption ---

  test("exempts /healthcheck (ALB probes send no headers)", async () => {
    const res = await get("/healthcheck");
    expect(res.status).toBe(200);
  });

  test("exempts /healthcheck with a query string (the ECS container probe)", async () => {
    const res = await get("/healthcheck?container=true");
    expect(res.status).toBe(200);
  });

  test("does NOT exempt the /healthcheck subtree", async () => {
    const res = await get("/healthcheck/details");
    expect(res.status).toBe(401);
  });

  // --- fail closed ---

  test("503s when PREVIEW_TOKEN is unset", async () => {
    delete process.env.PREVIEW_TOKEN;
    const res = await get("/api/v2/anything", {
      [PREVIEW_TOKEN_HEADER]: VALID_TOKEN,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Preview token not configured" });
  });

  test("503s when PREVIEW_TOKEN is shorter than 32 characters", async () => {
    process.env.PREVIEW_TOKEN = "too-short";
    const res = await get("/api/v2/anything", {
      [PREVIEW_TOKEN_HEADER]: "too-short",
    });
    expect(res.status).toBe(503);
  });

  test("still exempts /healthcheck when PREVIEW_TOKEN is unset", async () => {
    delete process.env.PREVIEW_TOKEN;
    const res = await get("/healthcheck");
    expect(res.status).toBe(200);
  });
});
