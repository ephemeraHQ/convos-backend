import { spawn } from "bun";
import { describe, expect, test } from "bun:test";

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
});
