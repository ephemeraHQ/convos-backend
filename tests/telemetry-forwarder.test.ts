import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forwardMetrics } from "@/api/v2/telemetry/services/forwarder";

let server: Server;
let url: string;
let lastBody: string | null = null;
let respondWith = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      lastBody = data;
      res.statusCode = respondWith;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  url = `http://127.0.0.1:${addr.port}/v1/metrics`;
});

afterAll(() => server.close());

describe("forwardMetrics", () => {
  test("POSTs JSON body and returns true on 200", async () => {
    respondWith = 200;
    const body = { resourceMetrics: [] };
    const ok = await forwardMetrics(body, url);
    expect(ok).toBe(true);
    expect(JSON.parse(lastBody ?? "")).toEqual(body);
  });

  test("returns false on 500", async () => {
    respondWith = 500;
    expect(await forwardMetrics({ resourceMetrics: [] }, url)).toBe(false);
  });

  test("returns false on connection refused", async () => {
    expect(
      await forwardMetrics({ resourceMetrics: [] }, "http://127.0.0.1:1/x"),
    ).toBe(false);
  });
});
