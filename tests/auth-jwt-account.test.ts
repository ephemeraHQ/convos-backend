import { beforeAll, describe, expect, test } from "vitest";
import { createJwtToken, validateJWTKeys, verifyJwtToken } from "@/utils/jwt";

beforeAll(async () => {
  await validateJWTKeys();
});

describe("V2JWTPayload accountId widening", () => {
  test("token without accountId verifies and has no accountId", async () => {
    const token = await createJwtToken({ deviceId: "dev-1" });
    const payload = await verifyJwtToken({ token });
    expect(payload.accountId).toBeUndefined();
  });

  test("token with accountId verifies and round-trips it", async () => {
    const accountId = "11111111-1111-1111-1111-111111111111";
    const token = await createJwtToken({ deviceId: "dev-2", accountId });
    const payload = await verifyJwtToken({ token });
    expect(payload.accountId).toBe(accountId);
  });

  test("zod schema is non-strict (regression): unknown keys are stripped, not rejected", async () => {
    // Mints a token containing an unknown key alongside the standard fields,
    // then verifies it: the unknown key should be silently dropped.
    const { createTestJwtWithPayload } = await import("@/utils/jwt");
    const token = await createTestJwtWithPayload({
      payload: {
        deviceId: "dev-3",
        accountId: "22222222-2222-2222-2222-222222222222",
        somethingNew: "future-feature",
      },
    });
    const payload = await verifyJwtToken({ token });
    expect(payload.deviceId).toBe("dev-3");
    expect(payload.accountId).toBe("22222222-2222-2222-2222-222222222222");
    expect((payload as Record<string, unknown>).somethingNew).toBeUndefined();
  });

  test("NSE tokens never carry accountId (regression)", async () => {
    const token = await createJwtToken({
      deviceId: "dev-nse",
      metadata: { notificationExtensionOnly: true },
    });
    const payload = await verifyJwtToken({ token });
    expect(payload.metadata?.notificationExtensionOnly).toBe(true);
    expect(payload.accountId).toBeUndefined();
  });
});
