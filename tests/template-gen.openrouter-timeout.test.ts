/**
 * OpenRouter timeout tests for the template generation service.
 *
 * Verifies the AbortController-based wallclock cap on the main OpenRouter
 * completion fetch:
 *   - fetch is invoked with an AbortSignal
 *   - AbortError surfaces as a typed timeout error
 *   - the timeout timer is cleared on the success path (no leak)
 *   - the timeout timer is cleared on the abort path (no leak)
 *   - the timeout timer is cleared on the non-2xx error path (finally runs)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-imports */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_API_KEY = "test-openrouter-api-key";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

interface TimerStats {
  setCount: number;
  clearCount: number;
}

let timerStats: TimerStats;

function installTimerSpy() {
  timerStats = { setCount: 0, clearCount: 0 };
  globalThis.setTimeout = ((fn: any, ms?: number, ...args: any[]) => {
    timerStats.setCount++;
    return originalSetTimeout(fn, ms, ...args);
  }) as any;
  globalThis.clearTimeout = ((id: any) => {
    if (id !== undefined) {
      timerStats.clearCount++;
    }
    return originalClearTimeout(id);
  }) as any;
}

function restoreTimerSpy() {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

describe("templateGen service — OpenRouter wallclock timeout", () => {
  beforeEach(() => {
    process.env.BUILDER_OPENROUTER_API_KEY = TEST_API_KEY;
    delete process.env.BUILDER_MODEL;
    delete process.env.EXA_SERVICE_KEY;
    installTimerSpy();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreTimerSpy();
    delete process.env.BUILDER_OPENROUTER_API_KEY;
    delete process.env.BUILDER_MODEL;
    delete process.env.EXA_SERVICE_KEY;
  });

  test("OpenRouter fetch is invoked with an AbortSignal", async () => {
    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = ((input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        capturedSignal = init?.signal;
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "p",
                    agentName: "Bot",
                    emoji: "🤖",
                    description: "d",
                    category: "Work",
                    tools: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    await mod.generateTemplate({ text: "hi" });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test("AbortError from fetch surfaces as 'OpenRouter request timed out'", async () => {
    globalThis.fetch = ((input: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(mod.generateTemplate({ text: "hi" })).rejects.toThrow(
      /OpenRouter request timed out/i,
    );
  });

  test("timer is cleared on success path (no leak)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "p",
                    agentName: "Bot",
                    emoji: "🤖",
                    description: "d",
                    category: "Work",
                    tools: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as any;

    const before = { ...timerStats };
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    await mod.generateTemplate({ text: "hi" });

    const setDelta = timerStats.setCount - before.setCount;
    const clearDelta = timerStats.clearCount - before.clearCount;
    expect(setDelta).toBeGreaterThanOrEqual(1);
    expect(clearDelta).toBe(setDelta);
  });

  test("timer is cleared on abort path (no leak)", async () => {
    globalThis.fetch = ((input: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const before = { ...timerStats };
    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(mod.generateTemplate({ text: "hi" })).rejects.toThrow();

    const setDelta = timerStats.setCount - before.setCount;
    const clearDelta = timerStats.clearCount - before.clearCount;
    expect(setDelta).toBeGreaterThanOrEqual(1);
    expect(clearDelta).toBe(setDelta);
  });

  test("timer is cleared on non-2xx error path (finally runs)", async () => {
    globalThis.fetch = ((input: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as any;

    const before = { ...timerStats };
    const mod = await import("@/api/v2/agent-templates/services/templateGen");

    await expect(mod.generateTemplate({ text: "hi" })).rejects.toThrow(
      /OpenRouter API error 500/,
    );

    const setDelta = timerStats.setCount - before.setCount;
    const clearDelta = timerStats.clearCount - before.clearCount;
    expect(setDelta).toBeGreaterThanOrEqual(1);
    expect(clearDelta).toBe(setDelta);
  });
});
