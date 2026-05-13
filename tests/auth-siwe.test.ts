import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import type { SiweMessage } from "siwe";
import { InvalidSiweError, verifySiwe } from "@/api/v2/auth/handlers/siwe";
import { buildSiweMessage } from "./helpers/siwe";

const NONCE = "abcdef".padEnd(64, "0");
const NOW = new Date("2026-05-08T12:00:00Z");
const TEST_DEVICE_ID = "test-device-id";

async function buildMessage(
  overrides: Partial<SiweMessage> = {},
  signerKey?: string,
) {
  return buildSiweMessage({
    deviceId: TEST_DEVICE_ID,
    nonce: NONCE,
    signerKey,
    now: NOW,
    overrides,
  });
}

async function expectInvalidSiwe(
  args: Parameters<typeof verifySiwe>[0],
  expectedReason?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await verifySiwe(args);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InvalidSiweError);
  if (expectedReason !== undefined) {
    expect((caught as InvalidSiweError).reason).toBe(expectedReason);
  }
}

describe("verifySiwe", () => {
  test("happy path returns lowercased address", async () => {
    const { messageStr, signature, address } = await buildMessage();
    const result = await verifySiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
    expect(result.address).toBe(address);
  });

  test("rejects when domain mismatches", async () => {
    const { messageStr, signature } = await buildMessage({
      domain: "evil.app",
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when nonce mismatches", async () => {
    const { messageStr, signature } = await buildMessage();
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: "00".repeat(32),
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when chainId not in allowlist", async () => {
    const { messageStr, signature } = await buildMessage({ chainId: 137 });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when uri mismatches", async () => {
    const { messageStr, signature } = await buildMessage({
      uri: "https://evil.app",
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when version is not 1", async () => {
    // siwe v3 strict-parses the constructor, so we can't build a v2 message via SiweMessage.
    // Build a valid v1 message, swap "Version: 1" → "Version: 2" in the string, then sign.
    // verifySiwe will fail to parse it and throw InvalidSiweError("parse"), which is the
    // correct behavior — a non-v1 message must be rejected, regardless of failure mode.
    const wallet = new Wallet("0x" + "1".repeat(64));
    const { messageStr } = await buildMessage();
    const tampered = messageStr.replace("Version: 1", "Version: 2");
    const signature = await wallet.signMessage(tampered);
    await expectInvalidSiwe(
      {
        message: tampered,
        signature,
        expectedNonce: NONCE,
        expectedDeviceId: TEST_DEVICE_ID,
        now: NOW,
      },
      "parse",
    );
  });

  test("rejects when expirationTime missing", async () => {
    const { messageStr, signature } = await buildMessage({
      expirationTime: undefined,
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when expirationTime in the past", async () => {
    const { messageStr, signature } = await buildMessage({
      expirationTime: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when expirationTime more than 10 minutes in future", async () => {
    const { messageStr, signature } = await buildMessage({
      expirationTime: new Date(NOW.getTime() + 11 * 60_000).toISOString(),
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when issuedAt skew exceeds 5 minutes", async () => {
    const { messageStr, signature } = await buildMessage({
      issuedAt: new Date(NOW.getTime() - 6 * 60_000).toISOString(),
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects when notBefore is in the future", async () => {
    const { messageStr, signature } = await buildMessage({
      notBefore: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    await expectInvalidSiwe({
      message: messageStr,
      signature,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });

  test("rejects bad signature (signed by different key)", async () => {
    const { messageStr } = await buildMessage();
    const otherWallet = new Wallet("0x" + "2".repeat(64));
    const badSig = await otherWallet.signMessage(messageStr);
    await expectInvalidSiwe({
      message: messageStr,
      signature: badSig,
      expectedNonce: NONCE,
      expectedDeviceId: TEST_DEVICE_ID,
      now: NOW,
    });
  });
});
