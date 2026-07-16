import { afterEach, describe, expect, test, vi } from "vitest";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";

const originalEnv = {
  CDN_BASE_URL: process.env.CDN_BASE_URL,
  POSTHOG_API_HOST: process.env.POSTHOG_API_HOST,
  POSTHOG_PERSONAL_API_KEY: process.env.POSTHOG_PERSONAL_API_KEY,
  POSTHOG_PROJECT_ID: process.env.POSTHOG_PROJECT_ID,
  POSTHOG_PROJECT_TOKEN: process.env.POSTHOG_PROJECT_TOKEN,
};

const restoreEnv = (name: keyof typeof originalEnv) => {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
};

afterEach(() => {
  for (const name of Object.keys(originalEnv) as Array<
    keyof typeof originalEnv
  >) {
    restoreEnv(name);
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("deletion executors", () => {
  test("public avatar deletion rejects foreign origins and account namespaces", async () => {
    process.env.CDN_BASE_URL = "https://assets.test";
    vi.resetModules();
    const { getDeletionExecutor, publicAvatarObjectKey } =
      await import("@/accounts/deletion/executors");

    expect(
      publicAvatarObjectKey({
        url: `https://evil.test/a/${ACCOUNT_ID}/${OBJECT_ID}`,
        accountId: ACCOUNT_ID,
      }),
    ).toBeNull();
    expect(
      publicAvatarObjectKey({
        url: `https://assets.test/a/${OTHER_ACCOUNT_ID}/${OBJECT_ID}`,
        accountId: ACCOUNT_ID,
      }),
    ).toBeNull();

    const executor = getDeletionExecutor("s3_object");
    await expect(
      executor?.({
        target: "public",
        accountId: ACCOUNT_ID,
        url: `https://evil.test/a/${ACCOUNT_ID}/${OBJECT_ID}`,
      }),
    ).resolves.toBeUndefined();
  });

  test("garbage public avatar URLs are successful no-ops", async () => {
    process.env.CDN_BASE_URL = "https://assets.test";
    vi.resetModules();
    const { getDeletionExecutor, publicAvatarObjectKey } =
      await import("@/accounts/deletion/executors");
    expect(
      publicAvatarObjectKey({ url: "not a URL", accountId: ACCOUNT_ID }),
    ).toBeNull();
    await expect(
      getDeletionExecutor("s3_object")?.({
        target: "public",
        accountId: ACCOUNT_ID,
        url: "not a URL",
      }),
    ).resolves.toBeUndefined();
  });

  test("owned canonical avatar URLs derive only the account-scoped key", async () => {
    process.env.CDN_BASE_URL = "https://assets.test/cdn";
    vi.resetModules();
    const { publicAvatarObjectKey } =
      await import("@/accounts/deletion/executors");
    expect(
      publicAvatarObjectKey({
        url: `https://assets.test/cdn/a/${ACCOUNT_ID}/${OBJECT_ID}`,
        accountId: ACCOUNT_ID,
      }),
    ).toBe(`a/${ACCOUNT_ID}/${OBJECT_ID}`);
  });

  test("PostHog deletion uses the private API host and timeouts on both requests", async () => {
    process.env.POSTHOG_PROJECT_TOKEN = "project-token";
    process.env.POSTHOG_PERSONAL_API_KEY = "personal-key";
    process.env.POSTHOG_PROJECT_ID = "project-1";
    delete process.env.POSTHOG_API_HOST;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [{ id: 42 }] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { getDeletionExecutor } =
      await import("@/accounts/deletion/executors");

    await getDeletionExecutor("posthog_person")?.({ distinctId: "acct/1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(lookupUrl).toBe(
      "https://us.posthog.com/api/projects/project-1/persons/?distinct_id=acct%2F1",
    );
    expect(deleteUrl).toBe(
      "https://us.posthog.com/api/projects/project-1/persons/42/?delete_events=true",
    );
    expect(lookupInit.signal).toBeInstanceOf(AbortSignal);
    expect(deleteInit.signal).toBeInstanceOf(AbortSignal);
  });
});
