/**
 * Unit tests for the distill service — the fast first pass that turns a build
 * request into the agent identity + progressPhrases.
 *
 * `parseDistillResponse` is pure (string → result) and carries the
 * distill-specific validation; `distill()` is exercised once end-to-end with a
 * mocked OpenRouter fetch to confirm the wiring (the OpenRouter plumbing itself
 * is covered by the template-gen tests).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __setDistillApiKeyOverrideForTests,
  distill,
  parseDistillResponse,
} from "@/api/v2/agent-templates/services/distill";
import { __resetOpenRouterClientForTests } from "@/api/v2/agent-templates/services/openrouter-client";

const VALID = {
  agentName: "Wave Boss",
  emoji: "🏄",
  description: "Coordinates the wake surf crew",
  progressPhrases: [
    "Writing how it thinks",
    "Shaping its voice",
    "Teaching it group manners",
    "Wiring its tools",
    "Setting its check-ins",
    "Drafting its hello",
  ],
};

describe("parseDistillResponse", () => {
  test("parses a well-formed JSON object", () => {
    const r = parseDistillResponse(JSON.stringify(VALID));
    expect(r.agentName).toBe("Wave Boss");
    expect(r.emoji).toBe("🏄");
    expect(r.description).toBe("Coordinates the wake surf crew");
    expect(r.progressPhrases).toHaveLength(6);
  });

  test("strips markdown fences", () => {
    const r = parseDistillResponse(
      "```json\n" + JSON.stringify(VALID) + "\n```",
    );
    expect(r.agentName).toBe("Wave Boss");
  });

  test("throws when agentName is missing", () => {
    const { agentName: _drop, ...rest } = VALID;
    expect(() => parseDistillResponse(JSON.stringify(rest))).toThrow(
      /agentName/,
    );
  });

  test("throws when there are too few progressPhrases", () => {
    expect(() =>
      parseDistillResponse(
        JSON.stringify({ ...VALID, progressPhrases: ["a", "b"] }),
      ),
    ).toThrow(/progressPhrases/);
  });

  test("filters blank phrases and rejects a non-emoji glyph", () => {
    const r = parseDistillResponse(
      JSON.stringify({
        ...VALID,
        emoji: "not-an-emoji",
        progressPhrases: [...VALID.progressPhrases, "   ", ""],
      }),
    );
    expect(r.emoji).toBe(""); // sanitized away — never ships a word as the glyph
    expect(r.progressPhrases).toHaveLength(6); // blanks dropped
  });
});

describe("distill()", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __setDistillApiKeyOverrideForTests("test-distill-key");
    __resetOpenRouterClientForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setDistillApiKeyOverrideForTests(undefined);
    __resetOpenRouterClientForTests();
  });

  test("returns the parsed identity + phrases from the LLM response", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "cmpl-1",
            model: "anthropic/claude-opus-4.8-fast",
            choices: [
              {
                message: { role: "assistant", content: JSON.stringify(VALID) },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const r = await distill("a wake surf crew coordinator");
    expect(r.agentName).toBe("Wave Boss");
    expect(r.progressPhrases).toHaveLength(6);
  });

  test("throws when the API key is not configured", async () => {
    __setDistillApiKeyOverrideForTests(null);
    await expect(distill("anything")).rejects.toThrow(
      /BUILDER_OPENROUTER_API_KEY/,
    );
  });
});
