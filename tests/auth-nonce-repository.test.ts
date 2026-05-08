import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { consumeNonce, issueNonce } from "@/api/v2/auth/auth-nonce.repository";
import { prisma } from "@/utils/prisma";

describe("auth-nonce.repository", () => {
  beforeAll(async () => {
    await prisma.authNonce.deleteMany();
  });

  afterEach(async () => {
    await prisma.authNonce.deleteMany();
  });

  test("issueNonce inserts a row and returns 64-char hex", async () => {
    const nonce = await issueNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.authNonce.findUnique({ where: { nonce } });
    expect(row?.nonce).toBe(nonce);
  });

  test("consumeNonce returns true and deletes the row", async () => {
    const nonce = await issueNonce();
    const ok = await consumeNonce(nonce);
    expect(ok).toBe(true);
    const row = await prisma.authNonce.findUnique({ where: { nonce } });
    expect(row).toBeNull();
  });

  test("consumeNonce returns false for unknown nonce", async () => {
    const ok = await consumeNonce("ff".repeat(32));
    expect(ok).toBe(false);
  });

  test("consumeNonce returns false on second call (single-use)", async () => {
    const nonce = await issueNonce();
    expect(await consumeNonce(nonce)).toBe(true);
    expect(await consumeNonce(nonce)).toBe(false);
  });

  test("consumeNonce returns false for expired nonce (older than 5 minutes)", async () => {
    const nonce = await issueNonce();
    await prisma.$executeRaw`
      UPDATE "AuthNonce" SET "createdAt" = now() - interval '6 minutes' WHERE nonce = ${nonce}
    `;
    expect(await consumeNonce(nonce)).toBe(false);
    // Row remains because filter excluded it; sweep handles it later.
    const row = await prisma.authNonce.findUnique({ where: { nonce } });
    expect(row).not.toBeNull();
  });
});
