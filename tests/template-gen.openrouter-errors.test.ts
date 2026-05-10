/**
 * OpenRouter error handling tests for the template generation service.
 *
 * Tests non-2xx → throw matching /OpenRouter API error N/ and
 * malformed 2xx → throw matching /no content|missing|empty/i.
 *
 * Fulfills: VAL-M3-OPENROUTER-009
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_API_KEY = "test-or-key-1234567890";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

let capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(input: any, init?: RequestInit): Response {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = init?.method || "GET";
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        headers[k] = v;
      }
    } else {
      Object.assign(headers, init.headers as Record<string, string>);
    }
  }
  let body: any = undefined;
  if (init?.body) {
    try {
      body = JSON.parse(init.body as string);
    } catch {
      body = init.body;
    }
  }
  capturedRequests.push({ url, method, headers, body });

  // Default: 200 with a valid template response
  return new Response(
    JSON.stringify({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("templateGen service — OpenRouter error handling", () => {
  let generateTemplate: typeof import("@/api/v2/agent-templates/services/templateGen").generateTemplate;

  beforeEach(() => {
    capturedRequests = [];
    globalThis.fetch = mockFetch as any;
    process.env.BUILDER_OPENROUTER_API_KEY = TEST_API_KEY;
    delete process.env.BUILDER_MODEL;
    delete process.env.EXA_SERVICE_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.BUILDER_OPENROUTER_API_KEY;
    delete process.env.BUILDER_MODEL;
    delete process.env.EXA_SERVICE_KEY;
  });

  // -----------------------------------------------------------------------
  // VAL-M3-OPENROUTER-009: Non-2xx OpenRouter response → thrown Error
  // -----------------------------------------------------------------------
  test("non-2xx 500 throws Error matching /OpenRouter API error 500/", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    // Override fetch to return 500 for OpenRouter calls
    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedRequests.push({
        url,
        method: init?.method || "GET",
        headers: {},
        body: null,
      });
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({ error: { message: "Internal server error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /OpenRouter API error 500/,
    );
  });

  test("non-2xx 429 throws Error matching /OpenRouter API error 429/", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({ error: { message: "Rate limited" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /OpenRouter API error 429/,
    );
  });

  test("non-2xx 401 throws Error matching /OpenRouter API error 401/", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({ error: { message: "Invalid API key" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /OpenRouter API error 401/,
    );
  });

  // -----------------------------------------------------------------------
  // 2xx with malformed body (missing choices[0].message.content)
  // -----------------------------------------------------------------------
  test("2xx with empty choices array throws matching /no content|missing|empty/i", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({ model: "@preset/assistants-pro", choices: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /no content|missing|empty/i,
    );
  });

  test("2xx with choices but missing message.content throws matching /no content|missing|empty/i", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [{ message: {} }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /no content|missing|empty/i,
    );
  });

  test("2xx with empty string message.content throws matching /no content|missing|empty/i", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [{ message: { content: "" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /no content|missing|empty/i,
    );
  });

  // -----------------------------------------------------------------------
  // 2xx with data.error from OpenRouter (provider error in 2xx body)
  // -----------------------------------------------------------------------
  test("2xx with data.error throws LLM error", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            error: { message: "Context length exceeded" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /LLM error/i,
    );
  });

  // -----------------------------------------------------------------------
  // Exa returning no content surfaces as a meaningful extraction error.
  // (Previously this test exercised a direct-fetch fallback that scraped
  // HTML directly; that fallback was removed to eliminate the user-URL
  // SSRF surface — see PR #200 review thread. Exa is now the sole
  // non-Twitter extraction path, so its no-content response is the
  // canonical "extraction failed" path.)
  // -----------------------------------------------------------------------
  test("Exa returning no content surfaces as an extraction error", async () => {
    process.env.EXA_SERVICE_KEY = "test-exa-key";
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const customFetch = (input: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === "https://api.exa.ai/contents") {
        return new Response(JSON.stringify({ results: [{ text: "" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = customFetch as any;

    await expect(
      generateTemplate({ text: "https://example.com" }),
    ).rejects.toThrow(/Exa returned no content/i);
  });
});
