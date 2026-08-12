import express, {
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type NextFunction,
} from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import { conversationsRouter } from "@/api/v2/conversations/conversations.router";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

const DEFAULT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "test-space-upstream-key";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const GOOD_VARIANT = "pr-test-space-upstream";
const GOOD_VARIANT_URL = `https://ephemeral-${GOOD_VARIANT}.convos.fun`;

const pullRequestResult = {
  conversationId: "conversation_abc",
  outcome: "pull_request",
  prUrl: "https://github.com/xmtplabs/convos-assistants/pull/123",
  prNumber: 123,
  branch: "space-upstream/conversation_abc",
  commitSha: "commit-sha",
  forkCommitSha: "fork-commit-sha",
  wrote: 4,
  deleted: 1,
  refusedCount: 2,
} as const;

const unchangedResult = {
  conversationId: "conversation_abc",
  outcome: "unchanged",
  forkCommitSha: "fork-commit-sha",
  wrote: 0,
  deleted: 0,
  refusedCount: 0,
} as const;

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
let nextIpOctet = 1;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accountMiddleware(
  _req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) {
  res.locals.accountId = ACCOUNT_ID;
  next();
}

function buildApp(options?: {
  auth?: boolean;
  errorLog?: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.set("trust proxy", 1);
  if (options?.errorLog) {
    app.use((req, _res, next) => {
      req.log = {
        error: options.errorLog,
        warn: vi.fn(),
        info: vi.fn(),
      } as unknown as ExpressRequest["log"];
      next();
    });
  } else {
    app.use(pinoMiddleware);
  }
  app.use(
    "/api/v2/conversations",
    options?.auth ? authMiddleware : accountMiddleware,
    conversationsRouter,
  );
  return app;
}

function proposal(
  app: ReturnType<typeof buildApp>,
  path = "/api/v2/conversations/CONVERSATION_ABC/debug/space-upstream",
  ip?: string,
) {
  const selectedIp = ip ?? `198.51.100.${nextIpOctet++}`;
  return request(app).post(path).set("X-Forwarded-For", selectedIp);
}

function responseBody(response: { body: unknown }): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

beforeAll(async () => {
  await validateJWTKeys();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  __setAssistantConfigOverridesForTests({});
});

beforeEach(() => {
  vi.restoreAllMocks();
  fetchCalls = [];
  __setAssistantConfigOverridesForTests({
    assistantApiUrl: DEFAULT_URL,
    assistantApiKey: ASSISTANT_KEY,
  });
  fetchImpl = (url, init) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(jsonResponse(200, pullRequestResult));
  };
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    const urlString =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return fetchImpl(urlString, init);
  };
  vi.spyOn(prisma.agentVariant, "findFirst").mockImplementation((args) => {
    const slug = (args?.where as { slug?: string } | undefined)?.slug;
    const assistantWorkerUrl = slug === GOOD_VARIANT ? GOOD_VARIANT_URL : null;
    return Promise.resolve(
      assistantWorkerUrl ? { assistantWorkerUrl } : null,
    ) as never;
  });
});

describe("POST /conversations/:conversationId/debug/space-upstream", () => {
  test("uses JWT auth and requires an account", async () => {
    const app = buildApp({ auth: true });

    const missing = await proposal(app);
    expect(missing.status).toBe(401);

    const accountlessToken = await createJwtToken({ deviceId: "device-only" });
    const accountless = await proposal(app).set(
      "X-Convos-AuthToken",
      accountlessToken,
    );
    expect(accountless.status).toBe(403);
    expect(accountless.body).toEqual({ error: "Account required" });

    const accountToken = await createJwtToken({
      deviceId: "device-account",
      accountId: ACCOUNT_ID,
    });
    const authenticated = await proposal(app).set(
      "X-Convos-AuthToken",
      accountToken,
    );
    expect(authenticated.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });

  test("forwards the bounded conversation ID verbatim and sends only the shared key", async () => {
    const res = await proposal(buildApp());
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${DEFAULT_URL}/api/conversations/CONVERSATION_ABC/space-upstream`,
    );
    expect(fetchCalls[0]?.init).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${ASSISTANT_KEY}` },
    });
    expect(fetchCalls[0]?.init?.body).toBeUndefined();
    expect(fetchCalls[0]?.init?.headers).toEqual({
      Authorization: `Bearer ${ASSISTANT_KEY}`,
    });
  });

  test.each([
    ["blank", "%20"],
    ["overlong", "a".repeat(257)],
  ])("rejects an %s conversation ID before fetch", async (_label, id) => {
    const res = await proposal(
      buildApp(),
      `/api/v2/conversations/${id}/debug/space-upstream`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: "INVALID_REQUEST",
      message: "Invalid Space PR proposal request",
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test.each([
    ["empty", "variantId="],
    ["array", "variantId=one&variantId=two"],
    ["overlong", `variantId=${"a".repeat(65)}`],
  ])("rejects an %s provided variant", async (_label, query) => {
    const res = await proposal(
      buildApp(),
      `/api/v2/conversations/conversation_abc/debug/space-upstream?${query}`,
    );
    expect(res.status).toBe(400);
    expect(responseBody(res).error).toBe("INVALID_REQUEST");
    expect(fetchCalls).toHaveLength(0);
  });

  test("ignores unrelated query keys and uses the default Worker", async () => {
    const res = await proposal(
      buildApp(),
      "/api/v2/conversations/conversation_abc/debug/space-upstream?future=value",
    );
    expect(res.status).toBe(200);
    expect(fetchCalls[0]?.url).toBe(
      `${DEFAULT_URL}/api/conversations/conversation_abc/space-upstream`,
    );
  });

  test("passes the parsed variant slug to the registry and uses its exact origin", async () => {
    const res = await proposal(
      buildApp(),
      `/api/v2/conversations/conversation_abc/debug/space-upstream?variantId=${GOOD_VARIANT}`,
    );
    expect(res.status).toBe(200);
    expect(fetchCalls[0]?.url).toBe(
      `${GOOD_VARIANT_URL}/api/conversations/conversation_abc/space-upstream`,
    );
  });

  test("fails a non-allowed variant closed without fetching", async () => {
    const res = await proposal(
      buildApp(),
      "/api/v2/conversations/conversation_abc/debug/space-upstream?variantId=unknown-space-variant",
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: "VARIANT_UNAVAILABLE",
      message: "The selected agent variant is unavailable",
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("uses a 50-second upstream AbortSignal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const res = await proposal(buildApp());
      expect(res.status).toBe(200);
      expect(timeoutSpy).toHaveBeenCalledWith(50_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("returns unavailable without the optional shared key", async () => {
    __setAssistantConfigOverridesForTests({
      assistantApiUrl: DEFAULT_URL,
      assistantApiKey: "",
    });
    const res = await proposal(buildApp());
    expect(res.status).toBe(503);
    expect(responseBody(res).error).toBe("SPACE_UPSTREAM_UNAVAILABLE");
    expect(fetchCalls).toHaveLength(0);
  });

  test.each([
    [403, "space_upstream_not_armed", 503, "SPACE_UPSTREAM_NOT_ARMED"],
    [404, "space_not_found", 404, "SPACE_NOT_FOUND"],
    [409, "space_repository_unavailable", 409, "SPACE_REPOSITORY_UNAVAILABLE"],
    [
      503,
      "space_repository_provider_unavailable",
      503,
      "SPACE_UPSTREAM_UNAVAILABLE",
    ],
    [422, "space_upstream_refused", 422, "SPACE_UPSTREAM_REFUSED"],
    [502, "space_upstream_github_failed", 502, "SPACE_UPSTREAM_GITHUB_FAILED"],
    [502, "space_upstream_failed", 502, "SPACE_UPSTREAM_FAILED"],
    [504, "space_upstream_timeout", 504, "SPACE_UPSTREAM_TIMEOUT"],
    [401, "unauthorized", 502, "SPACE_UPSTREAM_FAILED"],
  ])(
    "maps Worker %i %s to %i %s",
    async (workerStatus, workerCode, expectedStatus, expectedCode) => {
      fetchImpl = (url, init) => {
        fetchCalls.push({ url, init });
        return Promise.resolve(
          jsonResponse(workerStatus, {
            error: "Safe upstream detail",
            code: workerCode,
          }),
        );
      };
      const res = await proposal(buildApp());
      expect(res.status).toBe(expectedStatus);
      expect(responseBody(res).error).toBe(expectedCode);
      if (workerCode === "space_upstream_refused") {
        expect(responseBody(res).message).toBe("Safe upstream detail");
      }
    },
  );

  test.each([
    ["uncoded old-route 404", 404, { error: "Not found" }],
    ["unexpected code", 418, { error: "No", code: "unexpected" }],
  ])("maps %s to the generic failure", async (_label, status, body) => {
    fetchImpl = (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(jsonResponse(status, body));
    };
    const res = await proposal(buildApp());
    expect(res.status).toBe(502);
    expect(responseBody(res).error).toBe("SPACE_UPSTREAM_FAILED");
  });

  test("accepts additive fields in a coded Worker error", async () => {
    fetchImpl = (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(
        jsonResponse(404, {
          error: "Not found",
          code: "space_not_found",
          extra: true,
        }),
      );
    };
    const res = await proposal(buildApp());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: "SPACE_NOT_FOUND",
      message: "No Space was found for this conversation",
    });
  });

  test("separates timeout and network failures", async () => {
    fetchImpl = () =>
      Promise.reject(new DOMException("Timed out", "TimeoutError"));
    const timedOut = await proposal(buildApp());
    expect(timedOut.status).toBe(504);
    expect(responseBody(timedOut).error).toBe("SPACE_UPSTREAM_TIMEOUT");

    fetchImpl = () => Promise.reject(new TypeError("network unavailable"));
    const networkFailure = await proposal(buildApp());
    expect(networkFailure.status).toBe(502);
    expect(responseBody(networkFailure).error).toBe("SPACE_UPSTREAM_FAILED");
  });

  test.each([pullRequestResult, unchangedResult])(
    "returns a valid $outcome result transparently",
    async (result) => {
      fetchImpl = (url, init) => {
        fetchCalls.push({ url, init });
        return Promise.resolve(jsonResponse(200, result));
      };
      const res = await proposal(buildApp());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, ...result });
    },
  );

  test.each([
    ["malformed JSON", "not-json"],
    ["unknown outcome", { ...unchangedResult, outcome: "queued" }],
    [
      "missing required field",
      { ...unchangedResult, forkCommitSha: undefined },
    ],
  ])("rejects a %s success response", async (_label, body) => {
    fetchImpl = (url, init) => {
      fetchCalls.push({ url, init });
      if (typeof body === "string") {
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, body));
    };
    const res = await proposal(buildApp());
    expect(res.status).toBe(502);
    expect(responseBody(res).error).toBe("SPACE_UPSTREAM_FAILED");
  });

  test("accepts additive fields in a valid Worker result", async () => {
    fetchImpl = (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(
        jsonResponse(200, {
          ...unchangedResult,
          futureField: true,
        }),
      );
    };
    const res = await proposal(buildApp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ...unchangedResult });
  });

  test("caps upstream body diagnostics", async () => {
    const errorLog = vi.fn();
    fetchImpl = () =>
      Promise.resolve(
        new Response("x".repeat(1_000), {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    const res = await proposal(buildApp({ errorLog }));
    expect(res.status).toBe(502);
    expect(errorLog).toHaveBeenCalledWith(
      { status: 500, bodyPreview: "x".repeat(200) },
      "Space upstream Worker request failed",
    );
  });

  test("returns the exact IP-keyed mutation limit response", async () => {
    const app = buildApp();
    const ip = "203.0.113.77";
    for (let index = 0; index < 10; index += 1) {
      const allowed = await proposal(app, undefined, ip);
      expect(allowed.status).toBe(200);
    }
    const limited = await proposal(app, undefined, ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: "RATE_LIMITED",
      message: "Too many Space PR proposals; retry shortly",
    });

    const otherIp = await proposal(app, undefined, "203.0.113.78");
    expect(otherIp.status).toBe(200);
  });
});
