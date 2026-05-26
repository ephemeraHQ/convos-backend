/**
 * Unit tests for the assistants-dashboard revalidate service.
 *
 * Covers:
 *   - no-op when secret is unset
 *   - posts the expected URL/body/bearer when configured
 *   - swallows network errors (best-effort contract)
 *   - revalidateTemplate emits templates + template:<id> + template:<urlSlug>
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __setBaseUrlForTests,
  __setFetchForTests,
  __setSecretForTests,
  revalidateDashboardTags,
  revalidateTemplate,
} from "@/api/v2/agent-templates/services/revalidate-dashboard";
import { buildUrlSlug } from "@/utils/url-slug";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let captured: CapturedRequest[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = () =>
  Promise.resolve(new Response(null, { status: 200 }));

const installFetch = () => {
  // Cast through `unknown` because the in-tree `typeof fetch` is Bun's
  // flavoured signature (BunFetchRequestInit); we only need the standard
  // shape to drive these tests.
  const stub = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(
        init.headers as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    captured.push({ url, method, headers, body });
    return fetchImpl(url, init ?? {});
  }) as unknown as typeof fetch;
  __setFetchForTests(stub);
};

// Silent log shim so the warn path doesn't spam test output.
const silentLog = { warn: () => undefined, info: () => undefined };

beforeEach(() => {
  captured = [];
  fetchImpl = () => Promise.resolve(new Response(null, { status: 200 }));
  installFetch();
  __setSecretForTests("test-secret");
  __setBaseUrlForTests("https://dash.test.example");
});

afterEach(() => {
  __setFetchForTests(null);
  __setSecretForTests(undefined);
  __setBaseUrlForTests(undefined);
});

describe("revalidateDashboardTags", () => {
  test("no-ops when no tags provided", async () => {
    await revalidateDashboardTags({ tags: [], log: silentLog });
    expect(captured).toHaveLength(0);
  });

  test("no-ops when secret is unset", async () => {
    __setSecretForTests(null);
    await revalidateDashboardTags({ tags: ["templates"], log: silentLog });
    expect(captured).toHaveLength(0);
  });

  test("posts tags + bearer to <base>/api/revalidate", async () => {
    await revalidateDashboardTags({
      tags: ["templates", "template:abc"],
      log: silentLog,
    });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://dash.test.example/api/revalidate");
    expect(request.headers.authorization).toBe("Bearer test-secret");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toEqual({ tags: ["templates", "template:abc"] });
  });

  test("strips trailing slashes from the base URL", async () => {
    __setBaseUrlForTests("https://dash.test.example///");
    await revalidateDashboardTags({ tags: ["templates"], log: silentLog });
    expect(captured[0]?.url).toBe("https://dash.test.example/api/revalidate");
  });

  test("swallows non-2xx response without throwing", async () => {
    fetchImpl = () => Promise.resolve(new Response("nope", { status: 500 }));
    await revalidateDashboardTags({ tags: ["templates"], log: silentLog });
    // Reaching this line is the assertion; the call must not throw.
    expect(captured).toHaveLength(1);
  });

  test("swallows network errors without throwing", async () => {
    fetchImpl = () => Promise.reject(new Error("ECONNREFUSED"));
    await revalidateDashboardTags({ tags: ["templates"], log: silentLog });
    expect(captured).toHaveLength(1);
  });
});

describe("revalidateTemplate", () => {
  test("emits templates + template:<id> + template:<urlSlug>", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const slug = "brewski";
    const urlSlug = buildUrlSlug(slug, id);

    await revalidateTemplate({ id, slug, log: silentLog });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toEqual({
      tags: ["templates", `template:${id}`, `template:${urlSlug}`],
    });
  });
});
