/**
 * Unit tests for Twitter Reply Composition service.
 *
 * Validates VAL-TB-REPLY-001 through VAL-TB-REPLY-005:
 *   - REPLY-001: Reply starts with @handle and contains template URL
 *   - REPLY-002: Reply does not exceed 270 characters
 *   - REPLY-003: Reply uses deterministic fallback when LLM fails
 *   - REPLY-004: Reply uses minimal fallback when agentName is unavailable
 *   - REPLY-005: Reply service uses BUILDER_OPENROUTER_API_KEY
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetTwitterReplyForTests,
  buildDeterministicFallback,
  buildMinimalFallback,
  composeReply,
  type ReplyInput,
} from "../src/api/v2/agent-templates/services/twitterReply";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock<typeof fetch>>;

beforeEach(() => {
  mockFetch = mock<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTwitterReplyForTests(null);
  delete process.env.BUILDER_OPENROUTER_API_KEY;
  delete process.env.TWITTER_REPLY_MODEL;
  delete process.env.TEMPLATE_SITE_URL;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setEnv(key = "test-openrouter-key") {
  process.env.BUILDER_OPENROUTER_API_KEY = key;
}

const defaultInput: ReplyInput = {
  handle: "@alice",
  agentName: "MathTutor 🧮",
  firstSentence:
    "A helpful math tutor that explains algebra and calculus step by step.",
  templateUrl: "https://convos.org/assistants/math-tutor",
  slug: "math-tutor",
};

/** Mock an OpenRouter response with a reply text. */
function mockOpenRouterReply(replyText: string) {
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: replyText } }],
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
// VAL-TB-REPLY-001: Reply starts with @handle and contains template URL
// ===========================================================================

describe("twitterReply — @handle + URL (VAL-TB-REPLY-001)", () => {
  test("LLM reply starts with @handle and contains template URL", async () => {
    setEnv();
    const url = "https://convos.org/assistants/math-tutor";
    mockOpenRouterReply(
      `@alice Your MathTutor 🧮 is ready! Check it out: ${url}`,
    );

    const result = await composeReply(defaultInput);
    expect(result.replyText).toMatch(/^@alice/);
    expect(result.replyText).toContain(url);
  });

  test("deterministic fallback starts with @handle and contains URL", async () => {
    // No API key → falls back to deterministic
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const result = await composeReply(defaultInput);
    expect(result.replyText).toMatch(/^@alice/);
    expect(result.replyText).toContain("math-tutor");
  });

  test("minimal fallback starts with @handle and contains URL", async () => {
    // No agentName → minimal fallback
    const input: ReplyInput = {
      ...defaultInput,
      agentName: "",
    };
    setEnv();

    const result = await composeReply(input);
    expect(result.replyText).toMatch(/^@alice/);
    expect(result.replyText).toContain("math-tutor");
  });

  test("handle without @ prefix is normalized", async () => {
    const input: ReplyInput = { ...defaultInput, handle: "bob" };
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const result = await composeReply(input);
    expect(result.replyText).toMatch(/^@bob/);
  });
});

// ===========================================================================
// VAL-TB-REPLY-002: Reply does not exceed 270 characters
// ===========================================================================

describe("twitterReply — 270 char limit (VAL-TB-REPLY-002)", () => {
  test("LLM reply is truncated to 270 chars if it exceeds", async () => {
    setEnv();
    const longReply = `@alice Your ${"very ".repeat(100)}long agent is ready! https://convos.org/assistants/math-tutor`;
    mockOpenRouterReply(longReply);

    const result = await composeReply(defaultInput);
    expect(result.replyText.length).toBeLessThanOrEqual(270);
  });

  test("deterministic fallback does not exceed 270 chars", async () => {
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const longInput: ReplyInput = {
      handle: "@someone_with_a_long_name",
      agentName: "Super Duper Long Agent Name That Goes On And On And On",
      firstSentence:
        "This is an extremely long first sentence that describes what the agent does in excruciating detail, covering every possible aspect of its functionality and purpose, which should definitely exceed the 270 character limit if not properly truncated.".repeat(
          3,
        ),
      templateUrl: "https://convos.org/assistants/some-very-long-slug-name",
      slug: "some-very-long-slug-name",
    };

    const result = await composeReply(longInput);
    expect(result.replyText.length).toBeLessThanOrEqual(270);
  });

  test("minimal fallback does not exceed 270 chars", () => {
    const input: ReplyInput = {
      handle: "@alice",
      agentName: "",
      firstSentence: "Some description",
      templateUrl: "https://convos.org/assistants/math-tutor",
      slug: "math-tutor",
    };

    const fallback = buildMinimalFallback(input);
    expect(fallback.length).toBeLessThanOrEqual(270);
  });

  test("buildDeterministicFallback truncates long firstSentence to fit", () => {
    const input: ReplyInput = {
      handle: "@alice",
      agentName: "MathTutor",
      firstSentence: "A".repeat(500),
      templateUrl: "https://convos.org/assistants/math-tutor",
      slug: "math-tutor",
    };

    const result = buildDeterministicFallback(input);
    expect(result.length).toBeLessThanOrEqual(270);
    expect(result).toMatch(/^@alice/);
  });
});

// ===========================================================================
// VAL-TB-REPLY-003: Reply uses deterministic fallback when LLM fails
// ===========================================================================

describe("twitterReply — deterministic fallback (VAL-TB-REPLY-003)", () => {
  test("falls back to deterministic template when OpenRouter returns 500", async () => {
    setEnv();
    mockOpenRouterError(500);

    const result = await composeReply(defaultInput);
    const expected = buildDeterministicFallback(defaultInput);
    expect(result.replyText).toBe(expected);
  });

  test("falls back to deterministic template when OpenRouter is unreachable", async () => {
    setEnv();
    mockNetworkError();

    const result = await composeReply(defaultInput);
    const expected = buildDeterministicFallback(defaultInput);
    expect(result.replyText).toBe(expected);
  });

  test("falls back to deterministic template when OpenRouter returns empty response", async () => {
    setEnv();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await composeReply(defaultInput);
    const expected = buildDeterministicFallback(defaultInput);
    expect(result.replyText).toBe(expected);
  });

  test("deterministic fallback format: @{handle} Meet {agentName} — {firstSentence}. {url}", async () => {
    setEnv();
    mockNetworkError();

    const result = await composeReply(defaultInput);
    expect(result.replyText).toMatch(/^@alice Meet MathTutor 🧮 — /);
    expect(result.replyText).toContain("math-tutor");
  });

  test("no second LLM call on failure — single fetch attempt", async () => {
    setEnv();
    mockOpenRouterError(500);

    await composeReply(defaultInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("falls back when BUILDER_OPENROUTER_API_KEY is not set", async () => {
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const result = await composeReply(defaultInput);
    const expected = buildDeterministicFallback(defaultInput);
    expect(result.replyText).toBe(expected);
  });
});

// ===========================================================================
// VAL-TB-REPLY-004: Reply uses minimal fallback when agentName is unavailable
// ===========================================================================

describe("twitterReply — minimal fallback (VAL-TB-REPLY-004)", () => {
  test("uses minimal fallback when agentName is empty string", async () => {
    setEnv();
    const input: ReplyInput = { ...defaultInput, agentName: "" };

    const result = await composeReply(input);
    const expected = buildMinimalFallback(input);
    expect(result.replyText).toBe(expected);
  });

  test("uses minimal fallback when agentName is whitespace-only", async () => {
    setEnv();
    const input: ReplyInput = { ...defaultInput, agentName: "   " };

    const result = await composeReply(input);
    expect(result.replyText).toMatch(/^@alice/);
    expect(result.replyText).toContain("math-tutor");
  });

  test("minimal fallback format: @{handle} {url}", () => {
    const input: ReplyInput = {
      handle: "@alice",
      agentName: "",
      firstSentence: "Whatever",
      templateUrl: "https://convos.org/assistants/math-tutor",
      slug: "math-tutor",
    };

    const result = buildMinimalFallback(input);
    expect(result).toBe("@alice https://convos.org/assistants/math-tutor");
  });

  test("minimal fallback does NOT include placeholder name like 'Your Agent'", () => {
    const input: ReplyInput = {
      handle: "@alice",
      agentName: "",
      firstSentence: "Whatever",
      templateUrl: "https://convos.org/assistants/math-tutor",
      slug: "math-tutor",
    };

    const result = buildMinimalFallback(input);
    expect(result).not.toContain("Your Agent");
    expect(result).not.toContain("Meet");
    expect(result).not.toContain("Agent");
  });

  test("no LLM call when agentName is unavailable — skips fetch entirely", async () => {
    setEnv();
    const input: ReplyInput = { ...defaultInput, agentName: "" };

    await composeReply(input);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// VAL-TB-REPLY-005: Reply service uses BUILDER_OPENROUTER_API_KEY
// ===========================================================================

describe("twitterReply — API key (VAL-TB-REPLY-005)", () => {
  test("sends Authorization: Bearer <BUILDER_OPENROUTER_API_KEY>", async () => {
    setEnv("my-reply-api-key");
    mockOpenRouterReply(
      "@alice Your MathTutor is ready! https://convos.org/assistants/math-tutor",
    );

    await composeReply(defaultInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer my-reply-api-key",
    });
  });

  test("uses TWITTER_REPLY_MODEL env var when set", async () => {
    setEnv();
    process.env.TWITTER_REPLY_MODEL = "custom/reply-model";
    mockOpenRouterReply(
      "@alice Your bot is ready! https://convos.org/assistants/math-tutor",
    );

    await composeReply(defaultInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body.model).toBe("custom/reply-model");
  });

  test("defaults to anthropic/claude-3-5-haiku-20241022 when TWITTER_REPLY_MODEL not set", async () => {
    setEnv();
    delete process.env.TWITTER_REPLY_MODEL;
    mockOpenRouterReply(
      "@alice Your bot is ready! https://convos.org/assistants/math-tutor",
    );

    await composeReply(defaultInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init?.body as string) || "{}");
    expect(body.model).toBe("anthropic/claude-3-5-haiku-20241022");
  });

  test("uses TEMPLATE_SITE_URL env var for URL construction", async () => {
    process.env.TEMPLATE_SITE_URL = "https://custom.example.com/bots";
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const input: ReplyInput = { ...defaultInput, agentName: "" };
    const result = await composeReply(input);

    expect(result.replyText).toContain(
      "https://custom.example.com/bots/math-tutor",
    );
  });

  test("defaults TEMPLATE_SITE_URL to https://convos.org/assistants", async () => {
    delete process.env.TEMPLATE_SITE_URL;
    delete process.env.BUILDER_OPENROUTER_API_KEY;

    const input: ReplyInput = { ...defaultInput, agentName: "" };
    const result = await composeReply(input);

    expect(result.replyText).toContain(
      "https://convos.org/assistants/math-tutor",
    );
  });
});

// ===========================================================================
// Test seam — __resetTwitterReplyForTests
// ===========================================================================

describe("twitterReply — test seam", () => {
  test("__resetTwitterReplyForTests installs override", async () => {
    __resetTwitterReplyForTests(() =>
      Promise.resolve({ replyText: "@alice custom reply" }),
    );

    const result = await composeReply(defaultInput);
    expect(result.replyText).toBe("@alice custom reply");
  });

  test("__resetTwitterReplyForTests(null) restores normal behaviour", async () => {
    __resetTwitterReplyForTests(() =>
      Promise.resolve({ replyText: "@alice overridden" }),
    );
    __resetTwitterReplyForTests(null);

    setEnv();
    mockOpenRouterReply(
      "@alice Your MathTutor is ready! https://convos.org/assistants/math-tutor",
    );

    const result = await composeReply(defaultInput);
    expect(result.replyText).toContain("MathTutor");
  });
});

// ===========================================================================
// buildDeterministicFallback — unit tests for the exported helper
// ===========================================================================

describe("buildDeterministicFallback", () => {
  test("produces @{handle} Meet {agentName} — {firstSentence}. {url}", () => {
    const result = buildDeterministicFallback(defaultInput);
    expect(result).toMatch(/^@alice Meet MathTutor 🧮 — /);
    expect(result).toContain("math-tutor");
  });

  test("truncates firstSentence with ellipsis when too long", () => {
    const input: ReplyInput = {
      ...defaultInput,
      firstSentence: "A".repeat(500),
    };
    const result = buildDeterministicFallback(input);
    expect(result.length).toBeLessThanOrEqual(270);
    expect(result).toContain("…");
  });

  test("normalizes handle without @ prefix", () => {
    const input: ReplyInput = { ...defaultInput, handle: "bob" };
    const result = buildDeterministicFallback(input);
    expect(result).toMatch(/^@bob/);
  });
});

// ===========================================================================
// buildMinimalFallback — unit tests for the exported helper
// ===========================================================================

describe("buildMinimalFallback", () => {
  test("produces exactly @{handle} {url}", () => {
    const result = buildMinimalFallback(defaultInput);
    expect(result).toBe("@alice https://convos.org/assistants/math-tutor");
  });

  test("normalizes handle without @ prefix", () => {
    const input: ReplyInput = { ...defaultInput, handle: "bob" };
    const result = buildMinimalFallback(input);
    expect(result).toBe("@bob https://convos.org/assistants/math-tutor");
  });
});
