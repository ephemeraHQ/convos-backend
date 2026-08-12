import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { prisma } from "@/utils/prisma";
import {
  PREVIEW_SEED_ACCOUNT_ID,
  PREVIEW_SEED_ATTEST_KEY,
  PREVIEW_SEED_CREDITS,
  PREVIEW_SEED_INVITE_CODES,
  PREVIEW_SEED_MARKER_KEY,
  PREVIEW_SEED_TEMPLATE_ID,
  seedPreview,
} from "../prisma/seed";

// The seed writes to the shared CI database. Every row it creates has a fixed
// id / key, so cleanup is exact and cannot touch another test's fixtures.
// `app_attest_enabled` in particular MUST be removed again: leaving it at
// "false" would silently disable App Check for any later test that reads it.
const cleanup = async () => {
  await prisma.agentTemplate.deleteMany({
    where: { id: PREVIEW_SEED_TEMPLATE_ID },
  });
  await prisma.userCredits.deleteMany({
    where: { accountId: PREVIEW_SEED_ACCOUNT_ID },
  });
  await prisma.account.deleteMany({ where: { id: PREVIEW_SEED_ACCOUNT_ID } });
  await prisma.inviteCode.deleteMany({
    where: { code: { in: [...PREVIEW_SEED_INVITE_CODES] } },
  });
  await prisma.runtimeConfig.deleteMany({
    where: { key: { in: [PREVIEW_SEED_MARKER_KEY, PREVIEW_SEED_ATTEST_KEY] } },
  });
};

describe("seedPreview", () => {
  const originalPreview = process.env.PREVIEW;

  beforeAll(cleanup);

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    if (originalPreview === undefined) {
      delete process.env.PREVIEW;
    } else {
      process.env.PREVIEW = originalPreview;
    }
  });

  test('writes nothing when PREVIEW is not "1"', async () => {
    delete process.env.PREVIEW;

    await expect(seedPreview(prisma)).resolves.toBe("skipped-not-preview");

    const marker = await prisma.runtimeConfig.findUnique({
      where: { key: PREVIEW_SEED_MARKER_KEY },
    });
    expect(marker).toBeNull();

    process.env.PREVIEW = "0";
    await expect(seedPreview(prisma)).resolves.toBe("skipped-not-preview");
    expect(
      await prisma.account.findUnique({
        where: { id: PREVIEW_SEED_ACCOUNT_ID },
      }),
    ).toBeNull();
  });

  test("seeds the preview fixtures on first run", async () => {
    process.env.PREVIEW = "1";

    await expect(seedPreview(prisma)).resolves.toBe("seeded");

    const marker = await prisma.runtimeConfig.findUnique({
      where: { key: PREVIEW_SEED_MARKER_KEY },
    });
    expect(marker).not.toBeNull();

    const attest = await prisma.runtimeConfig.findUnique({
      where: { key: PREVIEW_SEED_ATTEST_KEY },
    });
    expect(attest?.value).toBe("false");

    const codes = await prisma.inviteCode.findMany({
      where: { code: { in: [...PREVIEW_SEED_INVITE_CODES] } },
    });
    expect(codes).toHaveLength(PREVIEW_SEED_INVITE_CODES.length);

    const credits = await prisma.userCredits.findUnique({
      where: { accountId: PREVIEW_SEED_ACCOUNT_ID },
    });
    expect(credits?.balance).toBe(PREVIEW_SEED_CREDITS);

    const template = await prisma.agentTemplate.findUnique({
      where: { id: PREVIEW_SEED_TEMPLATE_ID },
    });
    expect(template?.ownerAccountId).toBe(PREVIEW_SEED_ACCOUNT_ID);
    expect(template?.status).toBe("published");
  });

  test("is idempotent — a second run changes nothing", async () => {
    process.env.PREVIEW = "1";
    await expect(seedPreview(prisma)).resolves.toBe("seeded");

    // Mutate a seeded row so a re-seed would be visible.
    await prisma.runtimeConfig.update({
      where: { key: PREVIEW_SEED_ATTEST_KEY },
      data: { value: "true" },
    });

    await expect(seedPreview(prisma)).resolves.toBe("already-seeded");

    const attest = await prisma.runtimeConfig.findUnique({
      where: { key: PREVIEW_SEED_ATTEST_KEY },
    });
    expect(attest?.value).toBe("true");

    const codes = await prisma.inviteCode.findMany({
      where: { code: { in: [...PREVIEW_SEED_INVITE_CODES] } },
    });
    expect(codes).toHaveLength(PREVIEW_SEED_INVITE_CODES.length);

    const accounts = await prisma.account.findMany({
      where: { id: PREVIEW_SEED_ACCOUNT_ID },
    });
    expect(accounts).toHaveLength(1);
  });

  test("re-seeds when the marker is gone but the fixtures remain", async () => {
    process.env.PREVIEW = "1";
    await expect(seedPreview(prisma)).resolves.toBe("seeded");

    // A partial cleanup: the marker goes, the fixed-id rows stay. With plain
    // `create` this raises P2002 and — since the entrypoint runs `db seed`
    // under `set -e` — wedges every subsequent container boot.
    await prisma.runtimeConfig.delete({
      where: { key: PREVIEW_SEED_MARKER_KEY },
    });

    await expect(seedPreview(prisma)).resolves.toBe("seeded");

    const accounts = await prisma.account.findMany({
      where: { id: PREVIEW_SEED_ACCOUNT_ID },
    });
    expect(accounts).toHaveLength(1);

    const credits = await prisma.userCredits.findUnique({
      where: { accountId: PREVIEW_SEED_ACCOUNT_ID },
    });
    expect(credits?.balance).toBe(PREVIEW_SEED_CREDITS);
  });
});
