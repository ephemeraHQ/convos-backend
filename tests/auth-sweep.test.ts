import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sweepNonces } from "@/api/v2/auth/sweep";
import { prisma } from "@/utils/prisma";

async function reset() {
  await prisma.authNonce.deleteMany();
}

describe("sweepNonces", () => {
  beforeAll(reset);
  afterEach(reset);

  test("deletes rows older than 1 hour, leaves recent rows alone", async () => {
    await prisma.authNonce.create({ data: { nonce: "a".repeat(64) } });
    await prisma.authNonce.create({ data: { nonce: "b".repeat(64) } });
    await prisma.$executeRaw`
      UPDATE "AuthNonce" SET "createdAt" = now() - interval '2 hours' WHERE nonce = ${"a".repeat(64)}
    `;

    await sweepNonces();

    const a = await prisma.authNonce.findUnique({
      where: { nonce: "a".repeat(64) },
    });
    const b = await prisma.authNonce.findUnique({
      where: { nonce: "b".repeat(64) },
    });
    expect(a).toBeNull();
    expect(b).not.toBeNull();
  });

  test("idempotent: running twice does not error", async () => {
    await sweepNonces();
    await sweepNonces();
  });
});
