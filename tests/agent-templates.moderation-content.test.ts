/**
 * Tests for the universal content moderation service.
 *
 * Covers:
 *   - Override installed → checkContent returns override's result
 *   - No override + no BUILDER_OPENROUTER_API_KEY → fails open
 *   - LLM returns "safe" → allowed
 *   - LLM returns "unsafe" → blocked
 *   - LLM returns unexpected label → fails open
 *   - OpenRouter non-2xx → fails open
 *   - OpenRouter network error → fails open
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  __resetModerationForTests,
  checkContent,
} from "@/api/v2/agent-templates/services/moderation";

// ---------------------------------------------------------------------------
// Fetch mocking — replaces global fetch for the duration of a test
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
type MockFetch = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

function installFetchMock(mock: MockFetch) {
  globalThis.fetch = mock as typeof globalThis.fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const llmResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Env snapshot/restore
// ---------------------------------------------------------------------------

const originalApiKey = process.env.BUILDER_OPENROUTER_API_KEY;

afterAll(() => {
  if (originalApiKey === undefined) {
    delete process.env.BUILDER_OPENROUTER_API_KEY;
  } else {
    process.env.BUILDER_OPENROUTER_API_KEY = originalApiKey;
  }
  __resetModerationForTests(null);
  restoreFetch();
});

afterEach(() => {
  __resetModerationForTests(null);
  restoreFetch();
});

describe("moderation.checkContent", () => {
  test("override installed → returns override's result (allowed)", async () => {
    __resetModerationForTests(() => Promise.resolve({ allowed: true }));
    const result = await checkContent("anything");
    expect(result.allowed).toBe(true);
  });

  test("override installed → returns override's result (blocked)", async () => {
    __resetModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );
    const result = await checkContent("anything");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocked");
  });

  describe("LLM-backed path (no override)", () => {
    beforeEach(() => {
      process.env.BUILDER_OPENROUTER_API_KEY = "test-key";
    });

    test("LLM returns 'safe' → allowed", async () => {
      installFetchMock(() => Promise.resolve(llmResponse("safe")));
      const result = await checkContent("hello there");
      expect(result.allowed).toBe(true);
    });

    test("LLM returns 'unsafe' → blocked", async () => {
      installFetchMock(() => Promise.resolve(llmResponse("unsafe")));
      const result = await checkContent("bad content here");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("blocked");
    });

    test("LLM returns unexpected label → fails open", async () => {
      installFetchMock(() => Promise.resolve(llmResponse("maybe")));
      const result = await checkContent("ambiguous");
      expect(result.allowed).toBe(true);
    });

    test("OpenRouter returns non-2xx → fails open", async () => {
      installFetchMock(() =>
        Promise.resolve(
          new Response("server error", {
            status: 500,
            headers: { "Content-Type": "text/plain" },
          }),
        ),
      );
      const result = await checkContent("anything");
      expect(result.allowed).toBe(true);
    });

    test("Network error → fails open", async () => {
      installFetchMock(() => Promise.reject(new Error("ECONNREFUSED")));
      const result = await checkContent("anything");
      expect(result.allowed).toBe(true);
    });

    test("Empty LLM response → fails open", async () => {
      installFetchMock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const result = await checkContent("anything");
      expect(result.allowed).toBe(true);
    });
  });

  describe("LLM-backed path (no API key)", () => {
    beforeEach(() => {
      delete process.env.BUILDER_OPENROUTER_API_KEY;
    });

    test("no BUILDER_OPENROUTER_API_KEY → fails open without fetch", async () => {
      let fetched = false;
      installFetchMock(() => {
        fetched = true;
        return Promise.resolve(llmResponse("unsafe"));
      });

      const result = await checkContent("would-be-unsafe");
      expect(result.allowed).toBe(true);
      expect(fetched).toBe(false);
    });
  });
});
