/**
 * Unit tests for the OpenRouter model-catalog lookup used to validate a
 * caller-supplied `builderModel` at submit time. Intercepts global fetch to
 * exercise catalog matching and the fail-open path; no DB or network.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  __setOpenRouterModelsForTests,
  isKnownOpenRouterModel,
} from "@/api/v2/agent-templates/services/openrouter-models";

const originalFetch = globalThis.fetch;

function mockModelsResponse(ids: string[]) {
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
    })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Clear the in-process cache so each test starts cold.
  __setOpenRouterModelsForTests(null);
});

describe("isKnownOpenRouterModel", () => {
  test("returns true for an id in the fetched catalog, false otherwise", async () => {
    mockModelsResponse([
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4.8-fast",
    ]);

    expect(await isKnownOpenRouterModel("anthropic/claude-opus-4.8")).toBe(
      true,
    );
    // Second call is served from cache (no second fetch needed).
    expect(await isKnownOpenRouterModel("anthropic/claude-opus-4.8-fast")).toBe(
      true,
    );
    expect(await isKnownOpenRouterModel("anthropic/made-up-model")).toBe(false);
  });

  test("fails open when the catalog can't be fetched and nothing is cached", async () => {
    globalThis.fetch = () => Promise.reject(new Error("network down"));

    expect(await isKnownOpenRouterModel("anything/at-all")).toBe(true);
  });

  test("test override bypasses the network entirely", async () => {
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("should not be called"));
    };
    __setOpenRouterModelsForTests(["anthropic/claude-opus-4.8"]);

    expect(await isKnownOpenRouterModel("anthropic/claude-opus-4.8")).toBe(
      true,
    );
    expect(await isKnownOpenRouterModel("anthropic/claude-opus-4.7")).toBe(
      false,
    );
    expect(fetchCalled).toBe(false);
  });
});
