import { describe, expect, test } from "bun:test";
import {
  buildInviteUrl,
  shouldAllowForcedErrors,
} from "@/api/v2/agents/handlers/join";

describe("buildInviteUrl", () => {
  test("uses production domain for production", () => {
    expect(buildInviteUrl("abc123", "production")).toBe(
      "https://popup.convos.org/v2?i=abc123",
    );
  });

  test("uses testnet domain for testnet", () => {
    expect(buildInviteUrl("abc123", "testnet")).toBe(
      "https://testnet.convos.org/v2?i=abc123",
    );
  });

  test("uses dev domain for all other environments", () => {
    expect(buildInviteUrl("abc123", "dev")).toBe(
      "https://dev.convos.org/v2?i=abc123",
    );
  });

  test("encodes invite slugs", () => {
    expect(buildInviteUrl("abc 123/?", "testnet")).toBe(
      "https://testnet.convos.org/v2?i=abc%20123%2F%3F",
    );
  });

  test("allows forced errors in dev-like environments only", () => {
    expect(shouldAllowForcedErrors("dev")).toBe(true);
    expect(shouldAllowForcedErrors("testnet")).toBe(true);
    expect(shouldAllowForcedErrors("production")).toBe(false);
  });
});
