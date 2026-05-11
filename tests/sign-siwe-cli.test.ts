import { spawn } from "bun";
import { describe, expect, test } from "bun:test";
import { recoverMessageAddress } from "viem";

const SCRIPT = "dev/scripts/sign-siwe.ts";

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = spawn(["bun", "run", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("sign-siwe.ts CLI — minimal", () => {
  test("no flags → exits non-zero with --nonce required", async () => {
    const { exitCode, stderr } = await runCli([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--nonce/);
  });

  test("--nonce <hex> only → exits 0, outputs valid JSON with message + signature", async () => {
    const nonce = "abcdef".padEnd(64, "0");
    const { exitCode, stdout, stderr } = await runCli(["--nonce", nonce]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { message: string; signature: string };
    expect(parsed.message).toBeTruthy();
    expect(parsed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(parsed.message).toContain(`Nonce: ${nonce}`);
    expect(parsed.message).toContain("Version: 1");
    expect(parsed.message).toContain("Chain ID: 1");
    expect(parsed.message).toContain("URI: https://convos.app");
    expect(parsed.message).toContain("convos.app wants you to sign in");
  });

  test("--nonce with no value at end of argv → exits non-zero", async () => {
    const { exitCode, stderr } = await runCli(["--nonce"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--nonce requires a value/);
  });

  test("--nonce followed by another flag → exits non-zero", async () => {
    const { exitCode, stderr } = await runCli(["--nonce", "--domain"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--nonce requires a value/);
  });
});

describe("sign-siwe.ts CLI — flag coverage", () => {
  const baseNonce = "fedcba".padEnd(64, "0");

  test("--domain override appears in message", async () => {
    const { exitCode, stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--domain",
      "evil.app",
    ]);
    expect(exitCode).toBe(0);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).toContain("evil.app wants you to sign in");
  });

  test("--uri override appears in message", async () => {
    const { stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--uri",
      "https://evil.app",
    ]);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).toContain("URI: https://evil.app");
  });

  test("--chain-id override appears in message", async () => {
    const { stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--chain-id",
      "137",
    ]);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).toContain("Chain ID: 137");
  });

  test("--chain-id rejects non-integer", async () => {
    const { exitCode, stderr } = await runCli([
      "--nonce",
      baseNonce,
      "--chain-id",
      "abc",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid --chain-id/);
  });

  test("--exp-offset +11m produces expirationTime ~11 min from now", async () => {
    const before = Date.now();
    const { stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--exp-offset",
      "+11m",
    ]);
    const after = Date.now();
    const { message } = JSON.parse(stdout) as { message: string };
    const exp = message.match(/Expiration Time: (.+)/)?.[1];
    expect(exp).toBeTruthy();
    const expMs = Date.parse(exp!);
    expect(expMs).toBeGreaterThanOrEqual(before + 11 * 60_000 - 1000);
    expect(expMs).toBeLessThanOrEqual(after + 11 * 60_000 + 1000);
  });

  test("--no-expiration omits Expiration Time", async () => {
    const { stdout } = await runCli(["--nonce", baseNonce, "--no-expiration"]);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).not.toContain("Expiration Time");
  });

  test("--tamper-version 2 produces message with Version: 2", async () => {
    const { stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--tamper-version",
      "2",
    ]);
    const { message } = JSON.parse(stdout) as { message: string };
    expect(message).toContain("Version: 2");
  });

  test("signature recovers to signer key's address (happy)", async () => {
    const { stdout } = await runCli(["--nonce", baseNonce]);
    const { message, signature } = JSON.parse(stdout) as {
      message: string;
      signature: string;
    };
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    const { privateKeyToAccount } = await import("viem/accounts");
    const expected = privateKeyToAccount(`0x${"1".repeat(64)}`).address;
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

  test("--signer-key + --address-override gives bad-signature shape", async () => {
    // EIP-55 checksummed form of 0xaaa...aaa
    const otherAddr =
      "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as `0x${string}`;
    const { stdout } = await runCli([
      "--nonce",
      baseNonce,
      "--signer-key",
      `0x${"2".repeat(64)}`,
      "--address-override",
      otherAddr,
    ]);
    const { message, signature } = JSON.parse(stdout) as {
      message: string;
      signature: string;
    };
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    expect(message).toContain(otherAddr);
    expect(recovered.toLowerCase()).not.toBe(otherAddr.toLowerCase());
  });
});
