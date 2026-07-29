import {
  APIException,
  Environment,
  type AppStoreServerAPIClient,
  type StatusResponse,
} from "@apple/app-store-server-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getSubscriptionStatusesWithEnvironmentFallback,
  resetAppleApiClientForTests,
  setAppleApiClientForEnvironmentForTests,
} from "@/subscriptions/apple-server-api";

// 4040010 TRANSACTION_ID_NOT_FOUND / 4040005 ORIGINAL_TRANSACTION_ID_NOT_FOUND:
// what the production host answers for a sandbox (TestFlight) transaction id —
// the fallback triggers. Anything else must propagate untouched.
const NOT_FOUND_TRANSACTION = 4040010;
const NOT_FOUND_ORIGINAL_TRANSACTION = 4040005;
const RATE_LIMITED = 4290000;

const statusResponse = (environment: string): StatusResponse => ({
  environment,
  bundleId: "app.convos",
  data: [],
});

const makeClient = (impl: (id: string) => Promise<StatusResponse>) => {
  const getAllSubscriptionStatuses = vi.fn(impl);
  return {
    client: {
      getAllSubscriptionStatuses,
    } as unknown as AppStoreServerAPIClient,
    getAllSubscriptionStatuses,
  };
};

let savedAppleEnv: string | undefined;

beforeEach(() => {
  savedAppleEnv = process.env.APPLE_ENV;
  // Pin the primary environment to production, like prod runs.
  process.env.APPLE_ENV = "production";
  resetAppleApiClientForTests();
});

afterEach(() => {
  if (savedAppleEnv === undefined) delete process.env.APPLE_ENV;
  else process.env.APPLE_ENV = savedAppleEnv;
  resetAppleApiClientForTests();
});

describe("getSubscriptionStatusesWithEnvironmentFallback", () => {
  test("production answers → production result, sandbox never consulted", async () => {
    const prod = makeClient(() =>
      Promise.resolve(statusResponse("Production")),
    );
    const sandbox = makeClient(() =>
      Promise.resolve(statusResponse("Sandbox")),
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.PRODUCTION,
      prod.client,
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.SANDBOX,
      sandbox.client,
    );

    const result =
      await getSubscriptionStatusesWithEnvironmentFallback("otx-1");

    expect(result.environment).toBe(Environment.PRODUCTION);
    expect(result.response.environment).toBe("Production");
    expect(prod.getAllSubscriptionStatuses).toHaveBeenCalledWith("otx-1");
    expect(sandbox.getAllSubscriptionStatuses).not.toHaveBeenCalled();
  });

  test.each([
    ["4040010 TRANSACTION_ID_NOT_FOUND", NOT_FOUND_TRANSACTION],
    [
      "4040005 ORIGINAL_TRANSACTION_ID_NOT_FOUND",
      NOT_FOUND_ORIGINAL_TRANSACTION,
    ],
  ])(
    "production %s → falls back to the sandbox host",
    async (_label, apiError) => {
      const prod = makeClient(() =>
        Promise.reject(new APIException(404, apiError)),
      );
      const sandbox = makeClient(() =>
        Promise.resolve(statusResponse("Sandbox")),
      );
      setAppleApiClientForEnvironmentForTests(
        Environment.PRODUCTION,
        prod.client,
      );
      setAppleApiClientForEnvironmentForTests(
        Environment.SANDBOX,
        sandbox.client,
      );

      const result =
        await getSubscriptionStatusesWithEnvironmentFallback("otx-tf");

      expect(result.environment).toBe(Environment.SANDBOX);
      expect(result.response.environment).toBe("Sandbox");
      expect(prod.getAllSubscriptionStatuses).toHaveBeenCalledWith("otx-tf");
      expect(sandbox.getAllSubscriptionStatuses).toHaveBeenCalledWith("otx-tf");
    },
  );

  test("non-not-found API error propagates — NO fallback", async () => {
    const prod = makeClient(() =>
      Promise.reject(new APIException(429, RATE_LIMITED)),
    );
    const sandbox = makeClient(() =>
      Promise.resolve(statusResponse("Sandbox")),
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.PRODUCTION,
      prod.client,
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.SANDBOX,
      sandbox.client,
    );

    await expect(
      getSubscriptionStatusesWithEnvironmentFallback("otx-1"),
    ).rejects.toBeInstanceOf(APIException);
    expect(sandbox.getAllSubscriptionStatuses).not.toHaveBeenCalled();
  });

  test("non-APIException (network error) propagates — NO fallback", async () => {
    const prod = makeClient(() => Promise.reject(new Error("ECONNRESET")));
    const sandbox = makeClient(() =>
      Promise.resolve(statusResponse("Sandbox")),
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.PRODUCTION,
      prod.client,
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.SANDBOX,
      sandbox.client,
    );

    await expect(
      getSubscriptionStatusesWithEnvironmentFallback("otx-1"),
    ).rejects.toThrow("ECONNRESET");
    expect(sandbox.getAllSubscriptionStatuses).not.toHaveBeenCalled();
  });

  test("explicit environment pins the host — not-found does NOT fall back", async () => {
    const prod = makeClient(() =>
      Promise.resolve(statusResponse("Production")),
    );
    const sandbox = makeClient(() =>
      Promise.reject(new APIException(404, NOT_FOUND_TRANSACTION)),
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.PRODUCTION,
      prod.client,
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.SANDBOX,
      sandbox.client,
    );

    await expect(
      getSubscriptionStatusesWithEnvironmentFallback("otx-1", {
        environment: Environment.SANDBOX,
      }),
    ).rejects.toBeInstanceOf(APIException);
    expect(prod.getAllSubscriptionStatuses).not.toHaveBeenCalled();
  });

  test("sandbox-primary (APPLE_ENV=sandbox) falls back to production on not-found", async () => {
    process.env.APPLE_ENV = "sandbox";
    const prod = makeClient(() =>
      Promise.resolve(statusResponse("Production")),
    );
    const sandbox = makeClient(() =>
      Promise.reject(new APIException(404, NOT_FOUND_TRANSACTION)),
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.PRODUCTION,
      prod.client,
    );
    setAppleApiClientForEnvironmentForTests(
      Environment.SANDBOX,
      sandbox.client,
    );

    const result =
      await getSubscriptionStatusesWithEnvironmentFallback("otx-1");

    expect(result.environment).toBe(Environment.PRODUCTION);
    expect(sandbox.getAllSubscriptionStatuses).toHaveBeenCalled();
    expect(prod.getAllSubscriptionStatuses).toHaveBeenCalled();
  });
});
