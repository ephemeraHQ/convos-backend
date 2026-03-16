import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import express from "express";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

// Track fetch calls to the pool
let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

// We need to set env vars before importing the handler (config.ts caches them)
const VALID_POOL_KEY =
  "test-pool-api-key-that-is-at-least-32-characters-long";
const POOL_URL = "https://pool.test.local";

process.env.AGENT_POOL_API_KEY = VALID_POOL_KEY;
process.env.AGENT_POOL_URL = POOL_URL;

const { createProvisionHandler } = await import(
  "@/api/v2/agents/provision/handlers/provision"
);

const emailHandler = createProvisionHandler("email");
const smsHandler = createProvisionHandler("sms");

app.post("/api/v2/agents/provision/email", emailHandler);
app.post("/api/v2/agents/provision/sms", smsHandler);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("provision endpoints", () => {
  let server: Server;
  const baseURL = "http://localhost:4011";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4011, () => resolve());
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    // Default: reject unmocked fetch calls
    mockFetchImpl = () => Promise.reject(new Error("unmocked fetch"));
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      mockFetchImpl(url, init)) as typeof fetch;
  });

  const post = (path: string, body: unknown) =>
    originalFetch(`${baseURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // --- Validation ---

  describe("request validation", () => {
    test("should return 400 for missing instanceId", async () => {
      const res = await post("/api/v2/agents/provision/email", {});
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("should return 400 for empty instanceId", async () => {
      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_REQUEST");
    });

    test("should return 400 for whitespace-only instanceId", async () => {
      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "   ",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_REQUEST");
    });
  });

  // --- Email provision ---

  describe("POST /api/v2/agents/provision/email", () => {
    test("should provision a new email", async () => {
      mockFetchImpl = (url, init) => {
        expect(url).toBe(`${POOL_URL}/api/proxy/email/provision`);
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init?.body as string) as {
          instanceId: string;
        };
        expect(body.instanceId).toBe("instance-123");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${VALID_POOL_KEY}`);

        return Promise.resolve(
          jsonResponse(200, {
            email: "agent-abc@convos.org",
            provisioned: true,
          }),
        );
      };

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        email: string;
        provisioned: boolean;
      };
      expect(data.success).toBe(true);
      expect(data.email).toBe("agent-abc@convos.org");
      expect(data.provisioned).toBe(true);
    });

    test("should return existing email with provisioned=false", async () => {
      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            email: "agent-abc@convos.org",
            provisioned: false,
          }),
        );

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        email: string;
        provisioned: boolean;
      };
      expect(data.success).toBe(true);
      expect(data.email).toBe("agent-abc@convos.org");
      expect(data.provisioned).toBe(false);
    });

    test("should return 502 when pool returns non-200", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(500, { error: "internal" }));

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("EMAIL_PROVISION_FAILED");
    });

    test("should return 502 when pool returns malformed response", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(200, { unexpected: "shape" }));

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("EMAIL_PROVISION_FAILED");
    });

    test("should return 504 on pool timeout", async () => {
      mockFetchImpl = () => {
        const err = new DOMException("The operation was aborted", "TimeoutError");
        return Promise.reject(err);
      };

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(504);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("AGENT_POOL_TIMEOUT");
    });

    test("should return 502 on network error", async () => {
      mockFetchImpl = () => Promise.reject(new Error("ECONNREFUSED"));

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "instance-123",
      });

      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("EMAIL_PROVISION_FAILED");
    });
  });

  // --- SMS provision ---

  describe("POST /api/v2/agents/provision/sms", () => {
    test("should provision a new phone number", async () => {
      mockFetchImpl = (url, init) => {
        expect(url).toBe(`${POOL_URL}/api/proxy/sms/provision`);
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${VALID_POOL_KEY}`);

        return Promise.resolve(
          jsonResponse(200, {
            phone: "+12025551234",
            provisioned: true,
          }),
        );
      };

      const res = await post("/api/v2/agents/provision/sms", {
        instanceId: "instance-456",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        phone: string;
        provisioned: boolean;
      };
      expect(data.success).toBe(true);
      expect(data.phone).toBe("+12025551234");
      expect(data.provisioned).toBe(true);
    });

    test("should return existing phone with provisioned=false", async () => {
      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            phone: "+12025551234",
            provisioned: false,
          }),
        );

      const res = await post("/api/v2/agents/provision/sms", {
        instanceId: "instance-456",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        phone: string;
        provisioned: boolean;
      };
      expect(data.success).toBe(true);
      expect(data.phone).toBe("+12025551234");
      expect(data.provisioned).toBe(false);
    });

    test("should return 502 when pool returns non-200", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(500, { error: "internal" }));

      const res = await post("/api/v2/agents/provision/sms", {
        instanceId: "instance-456",
      });

      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("SMS_PROVISION_FAILED");
    });

    test("should return 502 when pool returns malformed response", async () => {
      mockFetchImpl = () =>
        Promise.resolve(jsonResponse(200, { unexpected: "shape" }));

      const res = await post("/api/v2/agents/provision/sms", {
        instanceId: "instance-456",
      });

      expect(res.status).toBe(502);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("SMS_PROVISION_FAILED");
    });

    test("should return 504 on pool timeout", async () => {
      mockFetchImpl = () => {
        const err = new DOMException("The operation was aborted", "TimeoutError");
        return Promise.reject(err);
      };

      const res = await post("/api/v2/agents/provision/sms", {
        instanceId: "instance-456",
      });

      expect(res.status).toBe(504);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("AGENT_POOL_TIMEOUT");
    });
  });

  // --- URL construction ---

  describe("pool URL construction", () => {
    test("should strip trailing slashes from pool URL", async () => {
      mockFetchImpl = (url) => {
        expect(url).toBe(`${POOL_URL}/api/proxy/email/provision`);
        return Promise.resolve(
          jsonResponse(200, { email: "a@b.com", provisioned: true }),
        );
      };

      const res = await post("/api/v2/agents/provision/email", {
        instanceId: "test",
      });
      expect(res.status).toBe(200);
    });
  });
});
