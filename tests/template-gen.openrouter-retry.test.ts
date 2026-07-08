/**
 * Transient-connection retry tests for the template generation service.
 *
 * A dropped socket (undici "terminated" / ECONNRESET — the failure mode that
 * silently killed a Twitter build with no reply) is retried a couple of times
 * with backoff, while an HTTP error status and a caller/timeout abort stay
 * single-attempt. These assert the retry recovers a transient blip, gives up
 * after the budget, and never retries an abort.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_API_KEY = "test-or-key-retry-1234567890";

const originalFetch = globalThis.fetch;

function urlOf(input: any): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

/** A valid 200 completion the generate stage can parse into a template. */
function okTemplateResponse(): Response {
  return new Response(
    JSON.stringify({
      model: "anthropic/claude-opus-4.8-fast",
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

/** An undici-style dropped-socket rejection: `TypeError: terminated` with an
 *  `ECONNRESET` cause — exactly the shape that reached the executor as
 *  "Generate stage failed: terminated". */
function connectionResetError(): Error {
  const err = new TypeError("terminated");
  (err as any).cause = { code: "ECONNRESET", message: "read ECONNRESET" };
  return err;
}

describe("templateGen service — transient connection retry", () => {
  let orCalls: number;

  beforeEach(async () => {
    orCalls = 0;
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderApiKeyOverrideForTests(TEST_API_KEY);
    mod.__setBuilderModelOverrideForTests(null);
    mod.__setExaKeyOverrideForTests(null);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderApiKeyOverrideForTests(undefined);
    mod.__setBuilderModelOverrideForTests(null);
    mod.__setExaKeyOverrideForTests(undefined);
  });

  test("a transient connection reset is retried and then succeeds", async () => {
    globalThis.fetch = ((input: any) => {
      if (urlOf(input) === OPENROUTER_URL) {
        orCalls++;
        // Fail the first attempt, then serve a valid completion.
        return orCalls === 1
          ? Promise.reject(connectionResetError())
          : Promise.resolve(okTemplateResponse());
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const result = await mod.generateTemplate({ text: "Build me a bot" });

    expect(result.template.agentName).toBe("Bot");
    expect(orCalls).toBe(2); // one failure + one successful retry
  });

  test("a persistent connection reset is retried up to the budget, then throws", async () => {
    globalThis.fetch = ((input: any) => {
      if (urlOf(input) === OPENROUTER_URL) {
        orCalls++;
        return Promise.reject(connectionResetError());
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(
      mod.generateTemplate({ text: "Build me a bot" }),
    ).rejects.toThrow();
    expect(orCalls).toBe(3); // initial attempt + 2 retries
  });

  test("an abort/timeout is not retried", async () => {
    globalThis.fetch = ((input: any) => {
      if (urlOf(input) === OPENROUTER_URL) {
        orCalls++;
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(
      mod.generateTemplate({ text: "Build me a bot" }),
    ).rejects.toThrow(/timed out/i);
    expect(orCalls).toBe(1); // never retried
  });

  test("an HTTP 500 is not treated as a transient connection error", async () => {
    globalThis.fetch = ((input: any) => {
      if (urlOf(input) === OPENROUTER_URL) {
        orCalls++;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(
      mod.generateTemplate({ text: "Build me a bot" }),
    ).rejects.toThrow(/OpenRouter API error 500/);
    expect(orCalls).toBe(1); // HTTP status is a response, not a broken socket
  });
});

describe("openRouterChatCompletion — abort during retry backoff", () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const client =
      await import("@/api/v2/agent-templates/services/openrouter-client");
    client.__resetOpenRouterClientForTests();
  });

  test("aborting mid-backoff stops promptly instead of waiting out the delay", async () => {
    // First backoff is 250ms. Fail transiently so a retry is scheduled, then
    // abort ~5ms in — while the backoff timer is running. The abortable sleep
    // must hand control back at once (loop re-checks the signal and throws),
    // so total time stays far below the 250ms it would take if the sleep
    // ignored the signal and ran to completion.
    globalThis.fetch = ((input: any) => {
      if (urlOf(input) === OPENROUTER_URL) {
        return Promise.reject(connectionResetError());
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const client =
      await import("@/api/v2/agent-templates/services/openrouter-client");
    client.__resetOpenRouterClientForTests();

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 5);
    const startedMs = performance.now();
    await expect(
      client.openRouterChatCompletion({
        apiKey: TEST_API_KEY,
        stage: "generate",
        body: {
          model: "test/model",
          messages: [{ role: "user", content: "hi" }],
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    const elapsedMs = performance.now() - startedMs;
    clearTimeout(timer);

    expect(elapsedMs).toBeLessThan(150);
  });
});
