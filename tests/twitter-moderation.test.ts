/**
 * Unit tests for Twitter Moderation service.
 *
 *   - MOD-001: Returns { allowed: true } for safe, agent-request content
 *   - MOD-002: Returns { allowed: false, reason: "blocked" } for unsafe content
 *   - MOD-003: Returns { allowed: false, reason: "not_agent_request" } for non-agent-request content
 *   - MOD-004: Fails open — returns { allowed: true } when OpenRouter is unreachable or errors
 *   - MOD-005: Completes in under 5 seconds for typical inputs
 *   - MOD-006: Uses BUILDER_OPENROUTER_API_KEY (same key as generation)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetTwitterModerationForTests,
  moderateContent,
} from "../src/api/v2/agent-templates/services/twitterModeration";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalBuilderOpenRouterKey = process.env.BUILDER_OPENROUTER_API_KEY;
const originalTwitterModerationModel = process.env.TWITTER_MODERATION_MODEL;
let mockFetch: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  mockFetch = mock<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTwitterModerationForTests(null);
  if (originalBuilderOpenRouterKey === undefined) {
    delete process.env.BUILDER_OPENROUTER_API_KEY;
  } else {
    process.env.BUILDER_OPENROUTER_API_KEY = originalBuilderOpenRouterKey;
  }
  if (originalTwitterModerationModel === undefined) {
    delete process.env.TWITTER_MODERATION_MODEL;
  } else {
    process.env.TWITTER_MODERATION_MODEL = originalTwitterModerationModel;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setEnv(key = "test-openrouter-key") {
  process.env.BUILDER_OPENROUTER_API_KEY = key;
}

/** Mock an OpenRouter response with a classification label. */
function mockOpenRouterResponse(label: string) {
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: label } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

/** Mock an OpenRouter error response. */
function mockOpenRouterError(status: number, body = "Internal Server Error") {
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { "Content-Type": "text/plain" },
      }),
    ),
  );
}

/** Mock a network error (ECONNREFUSED). */
function mockNetworkError() {
  mockFetch.mockImplementation(() => {
    throw new Error("ECONNREFUSED: Connection refused");
  });
}

// ===========================================================================
// Returns { allowed: true } for safe, agent-request content
// ===========================================================================

describe("twitterModeration — safe agent requests", () => {
  test("returns { allowed: true } for 'Build me a math tutor bot'", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("Build me a math tutor bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } for 'Create a recipe assistant'", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("Create a recipe assistant");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } for 'Make me a travel planner'", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("Make me a travel planner");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } for 'I need a bot that helps with coding'", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("I need a bot that helps with coding");
    expect(result).toEqual({ allowed: true });
  });

  test("allowed result has no reason field", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("Build me a math tutor bot");
    expect(result).not.toHaveProperty("reason");
  });
});

// ===========================================================================
// Returns { allowed: false, reason: "blocked" } for unsafe content
// ===========================================================================

describe("twitterModeration — unsafe content", () => {
  test("returns { allowed: false, reason: 'blocked' } for hate speech", async () => {
    setEnv();
    mockOpenRouterResponse("unsafe_content");

    const result = await moderateContent("[hate speech example]");
    expect(result).toEqual({ allowed: false, reason: "blocked" });
  });

  test("returns { allowed: false, reason: 'blocked' } for violent content", async () => {
    setEnv();
    mockOpenRouterResponse("unsafe_content");

    const result = await moderateContent("[violent threat example]");
    expect(result).toEqual({ allowed: false, reason: "blocked" });
  });
});

// ===========================================================================
// Returns { allowed: false, reason: "not_agent_request" }
//                 for non-agent-request content
// ===========================================================================

describe("twitterModeration — non-agent-request content", () => {
  test("returns { allowed: false, reason: 'not_agent_request' } for 'follow me back'", async () => {
    setEnv();
    mockOpenRouterResponse("not_agent_request");

    const result = await moderateContent("follow me back");
    expect(result).toEqual({ allowed: false, reason: "not_agent_request" });
  });

  test("returns { allowed: false, reason: 'not_agent_request' } for 'retweet this'", async () => {
    setEnv();
    mockOpenRouterResponse("not_agent_request");

    const result = await moderateContent("retweet this");
    expect(result).toEqual({ allowed: false, reason: "not_agent_request" });
  });

  test("returns { allowed: false, reason: 'not_agent_request' } for generic greeting '@bot hi'", async () => {
    setEnv();
    mockOpenRouterResponse("not_agent_request");

    const result = await moderateContent("@bot hi");
    expect(result).toEqual({ allowed: false, reason: "not_agent_request" });
  });

  test("non-agent-request has reason='not_agent_request', NOT 'blocked'", async () => {
    setEnv();
    mockOpenRouterResponse("not_agent_request");

    const result = await moderateContent("good morning");
    expect(result.reason).toBe("not_agent_request");
    expect(result.reason).not.toBe("blocked");
  });
});

// ===========================================================================
// Fails open — returns { allowed: true } on OpenRouter errors
// ===========================================================================

describe("twitterModeration — fail-open on errors", () => {
  test("returns { allowed: true } when OpenRouter returns 500", async () => {
    setEnv();
    mockOpenRouterError(500);

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } when OpenRouter returns 401", async () => {
    setEnv();
    mockOpenRouterError(401, "Unauthorized");

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } when OpenRouter is unreachable (ECONNREFUSED)", async () => {
    setEnv();
    mockNetworkError();

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } when OpenRouter returns empty response", async () => {
    setEnv();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } when OpenRouter returns unexpected label", async () => {
    setEnv();
    mockOpenRouterResponse("something_unexpected");

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: true } when BUILDER_OPENROUTER_API_KEY is not set", async () => {
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });

  test("does NOT throw on any error — always returns a result", async () => {
    setEnv();
    mockNetworkError();

    // Must not throw — the function should swallow all errors
    const result = await moderateContent("Build me a bot");
    expect(result).toBeDefined();
    expect(result.allowed).toBe(true);
  });
});

// ===========================================================================
// Completes in under 5 seconds for typical inputs
// ===========================================================================

describe("twitterModeration — performance", () => {
  test("completes in under 5 seconds for typical input", async () => {
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const start = performance.now();
    await moderateContent("Build me a math tutor bot that helps with algebra");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });
});

// ===========================================================================
// Uses BUILDER_OPENROUTER_API_KEY
// ===========================================================================

describe("twitterModeration — API key", () => {
  test("sends Authorization: Bearer <BUILDER_OPENROUTER_API_KEY>", async () => {
    setEnv("my-moderation-api-key");
    mockOpenRouterResponse("safe_agent_request");

    await moderateContent("Build me a bot");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer my-moderation-api-key",
    });
  });

  test("uses TWITTER_MODERATION_MODEL env var when set", async () => {
    setEnv();
    process.env.TWITTER_MODERATION_MODEL = "custom/model-name";
    mockOpenRouterResponse("safe_agent_request");

    await moderateContent("Build me a bot");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body.model).toBe("custom/model-name");
  });

  test("defaults to anthropic/claude-3-5-haiku-20241022 when TWITTER_MODERATION_MODEL is not set", async () => {
    setEnv();
    delete process.env.TWITTER_MODERATION_MODEL;
    mockOpenRouterResponse("safe_agent_request");

    await moderateContent("Build me a bot");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body.model).toBe("anthropic/claude-3-5-haiku-20241022");
  });
});

// ===========================================================================
// Test seam — __resetTwitterModerationForTests
// ===========================================================================

describe("twitterModeration — test seam", () => {
  test("__resetTwitterModerationForTests installs override", async () => {
    __resetTwitterModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );

    const result = await moderateContent("anything");
    expect(result).toEqual({ allowed: false, reason: "blocked" });
  });

  test("__resetTwitterModerationForTests(null) restores normal behaviour", async () => {
    __resetTwitterModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );

    __resetTwitterModerationForTests(null);
    setEnv();
    mockOpenRouterResponse("safe_agent_request");

    const result = await moderateContent("Build me a bot");
    expect(result).toEqual({ allowed: true });
  });
});
