import type { Request } from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchParticipation,
  type AssistantTarget,
} from "@/api/v2/conversations/handlers/participation";

// A device keeps sending the variant selected in its debug menu long after that
// variant's worker is gone, because the registry row outlives the deployment.
// These pin the rule that a variant is a routing preference and never a
// correctness requirement: when it cannot answer, the default control plane
// does, rather than the member getting "Participation not updated".

const DEFAULT_BASE = "https://assistants.example/api";
const VARIANT_BASE = "https://ephemeral-pr-1.convos.fun";
const CONVERSATION = "conv-1";

function target(baseUrl: string): AssistantTarget {
  return { baseUrl, defaultBaseUrl: DEFAULT_BASE, headers: {} };
}

const req = {
  log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
} as unknown as Pick<Request, "log">;

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(handler(url));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("participation variant fallback", () => {
  test("an unreachable variant host falls back to the default worker", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      // What a torn-down ephemeral actually does: the hostname stops resolving.
      if (url.startsWith(VARIANT_BASE)) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const response = await fetchParticipation(
      req,
      target(VARIANT_BASE),
      CONVERSATION,
      { method: "PATCH" },
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.startsWith(DEFAULT_BASE)).toBe(true);
  });

  test.each([401, 403, 404])(
    "a variant answering %i falls back: it cannot serve this conversation",
    async (status) => {
      const calls = stubFetch((url) =>
        url.startsWith(VARIANT_BASE)
          ? new Response(null, { status })
          : new Response(null, { status: 200 }),
      );

      const response = await fetchParticipation(
        req,
        target(VARIANT_BASE),
        CONVERSATION,
        { method: "GET" },
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
    },
  );

  test("the discarded variant response is cancelled, not leaked", async () => {
    // Every call from a device pinned to a dead variant abandons one response.
    // Left unread, undici holds that connection until GC; cancelling returns it
    // now, so the fallback path cannot exhaust the pool.
    const abandoned = new Response("body the fallback never reads", {
      status: 404,
    });
    stubFetch((url) =>
      url.startsWith(VARIANT_BASE)
        ? abandoned
        : new Response(null, { status: 200 }),
    );

    await fetchParticipation(req, target(VARIANT_BASE), CONVERSATION, {
      method: "GET",
    });

    expect(abandoned.bodyUsed).toBe(true);
  });

  test("a variant's 500 is reported, not retried: the worker is there and broken", async () => {
    const calls = stubFetch(() => new Response(null, { status: 500 }));

    const response = await fetchParticipation(
      req,
      target(VARIANT_BASE),
      CONVERSATION,
      { method: "PATCH" },
    );

    expect(response.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  test("a timeout stays a timeout: a slow variant is live, not missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      calls.push(String(input));
      return Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    });

    await expect(
      fetchParticipation(req, target(VARIANT_BASE), CONVERSATION, {
        method: "GET",
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toHaveLength(1);
  });

  test("no variant pinned means exactly one call, to the default worker", async () => {
    const calls = stubFetch(() => new Response(null, { status: 200 }));

    await fetchParticipation(req, target(DEFAULT_BASE), CONVERSATION, {
      method: "GET",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith(DEFAULT_BASE)).toBe(true);
  });

  test("the default worker's own failure is never retried", async () => {
    const calls = stubFetch(() => new Response(null, { status: 404 }));

    const response = await fetchParticipation(
      req,
      target(DEFAULT_BASE),
      CONVERSATION,
      { method: "GET" },
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});
