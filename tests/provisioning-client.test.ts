/**
 * Unit tests for ProvisioningClient service.
 *
 * Validates VAL-CJ-PG-001 through VAL-CJ-PG-008:
 *   - PG-001: Service file exists with createAssistant + getAssistant methods
 *   - PG-002: Uses Bearer token from PROVISIONING_API_KEY
 *   - PG-003: createAssistant sends correct POST body shape
 *   - PG-004: createAssistant returns { instanceId } on 200
 *   - PG-005: getAssistant returns full status object with all fields
 *   - PG-006: Throws on non-2xx with status code and body
 *   - PG-007: Configurable base URL via PROVISIONING_API_URL
 *   - PG-008: Handles network errors gracefully
 *   - Lazy initialization: env vars read at call time, not import time
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetProvisioningClientForTests,
  ProvisioningClient,
} from "../src/api/v2/agent-templates/services/provisioningClient";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalProvisioningApiUrl = process.env.PROVISIONING_API_URL;
const originalProvisioningApiKey = process.env.PROVISIONING_API_KEY;
let mockFetch: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  mockFetch = mock<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetProvisioningClientForTests(null);
  if (originalProvisioningApiUrl === undefined) {
    delete process.env.PROVISIONING_API_URL;
  } else {
    process.env.PROVISIONING_API_URL = originalProvisioningApiUrl;
  }
  if (originalProvisioningApiKey === undefined) {
    delete process.env.PROVISIONING_API_KEY;
  } else {
    process.env.PROVISIONING_API_KEY = originalProvisioningApiKey;
  }
});

// ---------------------------------------------------------------------------
// Helper: set env vars
// ---------------------------------------------------------------------------

function setEnv(url = "https://provisioning.example.com", key = "pg-test-key") {
  process.env.PROVISIONING_API_URL = url;
  process.env.PROVISIONING_API_KEY = key;
}

// ---------------------------------------------------------------------------
// VAL-CJ-PG-001: Service file exists with required methods
// ---------------------------------------------------------------------------

describe("ProvisioningClient", () => {
  test("exports createAssistant and getAssistant methods", () => {
    expect(typeof ProvisioningClient.createAssistant).toBe("function");
    expect(typeof ProvisioningClient.getAssistant).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-002: Uses Bearer token from PROVISIONING_API_KEY
// ---------------------------------------------------------------------------

describe("ProvisioningClient — Bearer auth (VAL-CJ-PG-002)", () => {
  test("createAssistant sends Authorization: Bearer <PROVISIONING_API_KEY>", async () => {
    setEnv("https://provisioning.example.com", "my-secret-key");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Test",
      instructions: "Be helpful",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer my-secret-key",
    });
  });

  test("getAssistant sends Authorization: Bearer <PROVISIONING_API_KEY>", async () => {
    setEnv("https://provisioning.example.com", "another-key");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            instanceId: "inst-1",
            joinStatus: "joined",
            inboxId: "inbox-1",
            conversationId: "conv-1",
            createdAt: "2025-01-01T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await ProvisioningClient.getAssistant("inst-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer another-key",
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-003: createAssistant sends correct POST body shape
// ---------------------------------------------------------------------------

describe("ProvisioningClient — POST body shape (VAL-CJ-PG-003)", () => {
  test("sends POST to <baseURL>/api/assistants with required fields", async () => {
    setEnv("https://provisioning.example.com");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Math Tutor",
      instructions: "Help with math problems",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [reqUrl, init] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe("https://provisioning.example.com/api/assistants");
    expect(init?.method).toBe("POST");

    const body = JSON.parse((init?.body as string) || "{}");
    expect(body).toMatchObject({
      name: "Math Tutor",
      instructions: "Help with math problems",
      joinUrl: "xmtp:https://relay.example.com/join",
    });
  });

  test("includes profileImage and metadata when provided", async () => {
    setEnv("https://provisioning.example.com");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Tutor",
      instructions: "Be helpful",
      joinUrl: "xmtp:https://relay.example.com/join",
      profileImage: "https://cdn.example.com/avatar.png",
      metadata: { source: "create-job" },
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body).toMatchObject({
      name: "Tutor",
      instructions: "Be helpful",
      joinUrl: "xmtp:https://relay.example.com/join",
      profileImage: "https://cdn.example.com/avatar.png",
      metadata: { source: "create-job" },
    });
  });

  test("omits profileImage and metadata when not provided", async () => {
    setEnv("https://provisioning.example.com");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-3" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Simple",
      instructions: "Hi",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body).not.toHaveProperty("profileImage");
    expect(body).not.toHaveProperty("metadata");
  });

  test("sends Content-Type: application/json header", async () => {
    setEnv("https://provisioning.example.com");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Test",
      instructions: "Be helpful",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-004: createAssistant returns { instanceId } on 200
// ---------------------------------------------------------------------------

describe("ProvisioningClient — returns instanceId (VAL-CJ-PG-004)", () => {
  test("createAssistant returns { instanceId } on 200", async () => {
    setEnv();

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "abc-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await ProvisioningClient.createAssistant({
      name: "Test",
      instructions: "Hi",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    expect(result).toEqual({ instanceId: "abc-123" });
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-005: getAssistant returns full status object
// ---------------------------------------------------------------------------

describe("ProvisioningClient — getAssistant returns full status (VAL-CJ-PG-005)", () => {
  test("getAssistant returns object with all fields", async () => {
    setEnv();

    const statusResponse = {
      instanceId: "inst-full",
      joinStatus: "joined",
      inboxId: "inbox-abc",
      conversationId: "conv-xyz",
      joinFailureReason: null,
      createdAt: "2025-01-01T00:00:00Z",
      destroyedAt: null,
    };

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(statusResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await ProvisioningClient.getAssistant("inst-full");

    expect(result.instanceId).toBe("inst-full");
    expect(result.joinStatus).toBe("joined");
    expect(result.inboxId).toBe("inbox-abc");
    expect(result.conversationId).toBe("conv-xyz");
    expect(result.joinFailureReason).toBeNull();
    expect(result.createdAt).toBe("2025-01-01T00:00:00Z");
    expect(result.destroyedAt).toBeNull();
  });

  test("getAssistant returns fields for failed instance", async () => {
    setEnv();

    const statusResponse = {
      instanceId: "inst-fail",
      joinStatus: "failed",
      inboxId: null,
      conversationId: null,
      joinFailureReason: "Timeout waiting for acceptance",
      createdAt: "2025-01-01T00:00:00Z",
      destroyedAt: "2025-01-01T00:05:00Z",
    };

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(statusResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await ProvisioningClient.getAssistant("inst-fail");

    expect(result.joinStatus).toBe("failed");
    expect(result.joinFailureReason).toBe("Timeout waiting for acceptance");
    expect(result.destroyedAt).toBe("2025-01-01T00:05:00Z");
    expect(result.inboxId).toBeNull();
    expect(result.conversationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-006: Throws on non-2xx responses with status and body
// ---------------------------------------------------------------------------

describe("ProvisioningClient — non-2xx error handling (VAL-CJ-PG-006)", () => {
  test("createAssistant throws on 401 with status and body", async () => {
    setEnv();

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    try {
      await ProvisioningClient.createAssistant({
        name: "Test",
        instructions: "Hi",
        joinUrl: "xmtp:https://relay.example.com/join",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("401");
      expect(err.message).toContain("Unauthorized");
    }
  });

  test("createAssistant throws on 500 with status and body", async () => {
    setEnv();

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Internal Server Error", {
          status: 500,
        }),
      ),
    );

    try {
      await ProvisioningClient.createAssistant({
        name: "Test",
        instructions: "Hi",
        joinUrl: "xmtp:https://relay.example.com/join",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("500");
      expect(err.message).toContain("Internal Server Error");
    }
  });

  test("getAssistant throws on 404 with status and body", async () => {
    setEnv();

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    try {
      await ProvisioningClient.getAssistant("nonexistent-id");
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("404");
      expect(err.message).toContain("Not found");
    }
  });

  test("getAssistant throws on 400 with status and body", async () => {
    setEnv();

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Bad request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    try {
      await ProvisioningClient.getAssistant("inst-1");
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("400");
      expect(err.message).toContain("Bad request");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-007: Configurable base URL
// ---------------------------------------------------------------------------

describe("ProvisioningClient — configurable base URL (VAL-CJ-PG-007)", () => {
  test("createAssistant uses PROVISIONING_API_URL as base", async () => {
    setEnv("https://custom-provisioning.example.org");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Test",
      instructions: "Hi",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    const [reqUrl] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe(
      "https://custom-provisioning.example.org/api/assistants",
    );
  });

  test("getAssistant uses PROVISIONING_API_URL as base", async () => {
    setEnv("https://custom-provisioning.example.org");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            instanceId: "inst-1",
            joinStatus: "joined",
            createdAt: "2025-01-01T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await ProvisioningClient.getAssistant("inst-1");

    const [reqUrl] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe(
      "https://custom-provisioning.example.org/api/assistants/inst-1",
    );
  });

  test("throws when PROVISIONING_API_URL is not set", async () => {
    delete process.env.PROVISIONING_API_URL;
    process.env.PROVISIONING_API_KEY = "key";

    try {
      await ProvisioningClient.createAssistant({
        name: "Test",
        instructions: "Hi",
        joinUrl: "xmtp:https://relay.example.com/join",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("PROVISIONING_API_URL");
    }
  });

  test("throws when PROVISIONING_API_KEY is not set", async () => {
    process.env.PROVISIONING_API_URL = "https://provisioning.example.com";
    delete process.env.PROVISIONING_API_KEY;

    try {
      await ProvisioningClient.createAssistant({
        name: "Test",
        instructions: "Hi",
        joinUrl: "xmtp:https://relay.example.com/join",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("PROVISIONING_API_KEY");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-CJ-PG-008: Handles network errors gracefully
// ---------------------------------------------------------------------------

describe("ProvisioningClient — network error handling (VAL-CJ-PG-008)", () => {
  test("createAssistant throws descriptive error on network failure", async () => {
    setEnv();

    mockFetch.mockImplementation(() => {
      throw new TypeError("fetch failed");
    });

    try {
      await ProvisioningClient.createAssistant({
        name: "Test",
        instructions: "Hi",
        joinUrl: "xmtp:https://relay.example.com/join",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toMatch(/network|connect|fetch failed|unreachable/i);
    }
  });

  test("getAssistant throws descriptive error on network failure", async () => {
    setEnv();

    mockFetch.mockImplementation(() => {
      throw new TypeError("fetch failed");
    });

    try {
      await ProvisioningClient.getAssistant("inst-1");
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toMatch(/network|connect|fetch failed|unreachable/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Lazy initialization — env vars read at call time, not import time
// ---------------------------------------------------------------------------

describe("ProvisioningClient — lazy initialization", () => {
  test("reads env vars at call time, not at import time", async () => {
    // Set env AFTER import (this file was imported at the top)
    setEnv("https://lazy-provisioning.example.com", "lazy-key");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-lazy" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "Lazy",
      instructions: "Test lazy init",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    const [reqUrl, init] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe("https://lazy-provisioning.example.com/api/assistants");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer lazy-key",
    });
  });

  test("picks up env var changes between calls", async () => {
    setEnv("https://first.example.com", "first-key");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "inst-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await ProvisioningClient.createAssistant({
      name: "First",
      instructions: "First call",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    let [reqUrl, init] = mockFetch.mock.calls[0];
    expect(reqUrl).toBe("https://first.example.com/api/assistants");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer first-key",
    });

    // Change env var
    process.env.PROVISIONING_API_URL = "https://second.example.com";
    process.env.PROVISIONING_API_KEY = "second-key";

    await ProvisioningClient.createAssistant({
      name: "Second",
      instructions: "Second call",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    [reqUrl, init] = mockFetch.mock.calls[1];
    expect(reqUrl).toBe("https://second.example.com/api/assistants");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer second-key",
    });
  });
});

// ---------------------------------------------------------------------------
// Test seam — __resetProvisioningClientForTests
// ---------------------------------------------------------------------------

describe("ProvisioningClient — test seam", () => {
  test("__resetProvisioningClientForTests exists and is callable", () => {
    expect(typeof __resetProvisioningClientForTests).toBe("function");
  });

  test("test seam with override creates mock behavior", async () => {
    setEnv();

    const mockCreate = mock<
      (opts: {
        name: string;
        instructions: string;
        joinUrl: string;
      }) => Promise<{ instanceId: string }>
    >(() => Promise.resolve({ instanceId: "seam-inst" }));

    __resetProvisioningClientForTests({
      createAssistant: mockCreate,
    });

    const result = await ProvisioningClient.createAssistant({
      name: "Seam",
      instructions: "Test seam",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    expect(result).toEqual({ instanceId: "seam-inst" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("test seam with null restores real implementation", async () => {
    setEnv();

    // First set an override
    __resetProvisioningClientForTests({
      createAssistant: () => Promise.resolve({ instanceId: "override-inst" }),
    });

    // Then reset
    __resetProvisioningClientForTests(null);

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ instanceId: "real-inst" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await ProvisioningClient.createAssistant({
      name: "Reset",
      instructions: "After reset",
      joinUrl: "xmtp:https://relay.example.com/join",
    });

    expect(result).toEqual({ instanceId: "real-inst" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
