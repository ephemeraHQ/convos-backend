import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forwardMetrics } from "@/api/v2/telemetry/services/forwarder";
import { forwardTraces } from "@/api/v2/telemetry/services/trace-forwarder";

let server: Server;
let url: string;
let lastBody: string | null = null;
let respondWith = 200;
let redirectTo: string | null = null;

// A second, always-200 server used as a redirect destination. The point of the
// redirect test is that following the 3xx here would yield a *false* success;
// pointing at an unreachable host instead would pass for the wrong reason.
let redirectTarget: Server;
let redirectTargetUrl: string;

const listen = (s: Server): Promise<string> =>
  new Promise((resolve) => {
    s.listen(0, () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

const close = (s: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    s.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      lastBody = data;
      if (redirectTo !== null) {
        res.statusCode = 302;
        res.setHeader("Location", redirectTo);
        res.end();
        return;
      }
      res.statusCode = respondWith;
      res.end("{}");
    });
  });
  redirectTarget = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  url = `${await listen(server)}/v1/metrics`;
  redirectTargetUrl = `${await listen(redirectTarget)}/landed`;
});

afterAll(async () => {
  await Promise.all([close(server), close(redirectTarget)]);
});

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

describe("forwardTraces", () => {
  test("202 → ok, not permanent", async () => {
    respondWith = 202;
    expect(await forwardTraces({ resourceSpans: [] }, url)).toEqual({
      ok: true,
      permanent: false,
    });
  });

  // Status → permanent classification. Permanent ONLY for payload-fatal 4xx
  // (the agent rejected the bytes); auth/wrong-URL/timeout/throttle and all 5xx
  // are transient so a server-side fix or retry can still deliver the batch.
  test.each([
    [400, true], // Bad Request — malformed body
    [413, true], // Payload Too Large
    [415, true], // Unsupported Media Type
    [422, true], // Unprocessable Entity
    [401, false], // auth misconfig — retry after fix
    [403, false], // auth misconfig — retry after fix
    [404, false], // wrong OTLP_TRACES_FORWARD_URL — retry after fix
    [408, false], // Request Timeout
    [429, false], // Too Many Requests
    [500, false], // server error
    [503, false], // unavailable
  ])("%i → permanent=%s", async (status, permanent) => {
    respondWith = status;
    expect(await forwardTraces({ resourceSpans: [] }, url)).toEqual({
      ok: false,
      permanent,
    });
  });

  test("network error → transient", async () => {
    expect(
      await forwardTraces({ resourceSpans: [] }, "http://127.0.0.1:1/x"),
    ).toEqual({ ok: false, permanent: false });
  });

  test("redirect → transient, NOT a false success", async () => {
    // The redirect target returns 200. If the 3xx were followed, forwardTraces
    // would read that 200 as a successful ingest even though the batch never
    // reached the agent. redirect: "error" makes fetch throw instead, so this
    // lands in the catch as a transient failure.
    redirectTo = redirectTargetUrl;
    try {
      expect(await forwardTraces({ resourceSpans: [] }, url)).toEqual({
        ok: false,
        permanent: false,
      });
    } finally {
      redirectTo = null;
    }
  });
});
