/**
 * Twitter-intent gate — prompt-contract + label-mapping tests (no API key).
 *
 * These do NOT verify the classifier's judgment (that's the LLM's job, covered
 * empirically by tests/evals/twitter-intent.ts). They lock the wiring around it:
 * the tweet text and the implicit-request instructions actually reach the model,
 * and the returned label maps to the right allow/block result. A regression that
 * silently drops the implicit-request handling from the prompt, stops passing the
 * tweet through, or breaks the label mapping fails here without needing a key.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-imports */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_API_KEY = "test-intent-key-1234567890";
const originalFetch = globalThis.fetch;

let sentPrompt: string | null = null;

/** Mock OpenRouter to return `label`, capturing the prompt that was sent. */
function mockIntentLabel(label: string): void {
  sentPrompt = null;
  globalThis.fetch = ((input: any, init?: any) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === OPENROUTER_URL) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      sentPrompt = body?.messages?.[0]?.content ?? null;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "google/gemini-3.1-flash-lite",
            choices: [{ message: { content: label } }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as any;
}

describe("checkTwitterIntent — prompt contract + label mapping", () => {
  let mod: typeof import("@/api/v2/agent-templates/services/moderation");

  beforeEach(async () => {
    mod = await import("@/api/v2/agent-templates/services/moderation");
    const client =
      await import("@/api/v2/agent-templates/services/openrouter-client");
    client.__resetOpenRouterClientForTests();
    mod.__setBuilderApiKeyOverrideForTests(TEST_API_KEY);
    mod.__setContentModelOverrideForTests("google/gemini-3.1-flash-lite");
    mod.__resetTwitterIntentForTests(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mod.__setBuilderApiKeyOverrideForTests(undefined);
    mod.__setContentModelOverrideForTests(null);
  });

  test("sends the tweet text and the implicit-request instructions to the classifier", async () => {
    mockIntentLabel("agent_request");
    const input =
      "I want my friends and I to get notified about local shows that aren't $600 tickets to Taylor Swift/Beyonce.";

    await mod.checkTwitterIntent(input);

    expect(sentPrompt).toBeTruthy();
    // The tweet itself must reach the model.
    expect(sentPrompt).toContain(input);
    // Both labels must be offered.
    expect(sentPrompt).toContain("agent_request");
    expect(sentPrompt).toContain("not_agent_request");
    // The implicit-request handling must survive prompt edits — if this fails
    // after an intentional reword, update it, but confirm implicit asks are
    // still in scope (that's the whole point of this gate's tuning).
    expect(sentPrompt).toMatch(/does NOT have to use the words/i);
    expect(sentPrompt).toMatch(/EXISTING vs WANTED/i);
  });

  test("maps agent_request → allowed", async () => {
    mockIntentLabel("agent_request");
    const res = await mod.checkTwitterIntent("build me a math tutor bot");
    expect(res.allowed).toBe(true);
  });

  test("maps not_agent_request → blocked with reason", async () => {
    mockIntentLabel("not_agent_request");
    const res = await mod.checkTwitterIntent("gm ☀️");
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("not_agent_request");
  });

  test("an unexpected label fails open (allowed)", async () => {
    mockIntentLabel("maybe?");
    const res = await mod.checkTwitterIntent("hello there");
    expect(res.allowed).toBe(true);
  });
});
