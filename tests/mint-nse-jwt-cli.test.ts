import { spawn } from "bun";
import { describe, expect, test } from "bun:test";
import { validateJWTKeys, verifyJwtToken } from "@/utils/jwt";

const SCRIPT = "dev/scripts/mint-nse-jwt.ts";

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
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("mint-nse-jwt.ts CLI", () => {
  test("no flags → exits non-zero, mentions --device-id", async () => {
    const { exitCode, stderr } = await runCli([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--device-id/);
  });

  test("--device-id mints a verifiable NSE JWT (notificationExtensionOnly: true)", async () => {
    await validateJWTKeys();
    const { exitCode, stdout } = await runCli(["--device-id", "demo-nse-1"]);
    expect(exitCode).toBe(0);
    const token = stdout.trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = await verifyJwtToken({ token });
    expect(payload.deviceId).toBe("demo-nse-1");
    expect(payload.metadata?.notificationExtensionOnly).toBe(true);
    expect(payload.accountId).toBeUndefined();
  });
});
