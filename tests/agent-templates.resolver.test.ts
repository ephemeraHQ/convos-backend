import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveAgentTemplateByIdOrUrlSlug } from "@/api/v2/agent-templates/lib/resolve-id-or-url-slug";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import { hashId } from "@/utils/url-slug";

const OTHER_OWNER_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffff0002";

const testIds: string[] = [];

const cleanup = async () => {
  if (testIds.length > 0) {
    await prisma.agentTemplate.deleteMany({
      where: { id: { in: testIds } },
    });
  }
  await prisma.agentTemplate.deleteMany({
    where: { ownerAccountId: OTHER_OWNER_ID },
  });
  await prisma.account.deleteMany({ where: { id: OTHER_OWNER_ID } });
};

const createAccount = (args: { id: string }) =>
  prisma.account.upsert({
    where: { id: args.id },
    update: {},
    create: { id: args.id },
  });

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput>,
) => {
  const id = overrides.id ?? randomUUID();
  testIds.push(id);
  const slug = overrides.slug ?? id.replace(/-/g, "").slice(0, 12);

  return prisma.agentTemplate.create({
    data: {
      id,
      slug,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${id}`,
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? `Prompt for ${id}`,
      category: overrides.category ?? null,
      emoji: overrides.emoji ?? null,
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt:
        overrides.firstPublishedAt ?? new Date("2026-01-11T00:00:00.000Z"),
      status: overrides.status ?? "published",
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? new Date("2026-01-11T00:00:00.000Z"),
    },
  });
};

describe("agent template id-or-hashed-slug resolver", () => {
  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    testIds.length = 0;
  });

  test("resolves direct UUID ids and never falls back to bare slug lookups", async () => {
    const tmplId = await createTemplate({ slug: "unrelated" });
    await createTemplate({ slug: "brewski" });

    const byId = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: tmplId.id,
    });
    expect(byId?.id).toBe(tmplId.id);

    const bareSlug = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: "brewski",
    });
    expect(bareSlug).toBeNull();
  });

  test("splits hashed slugs on the last dot and validates hash syntax exactly", async () => {
    const tmpl = await createTemplate({ slug: "my-thing" });

    const correctHash = hashId(tmpl.id);
    const valid = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `my-thing.${correctHash}`,
    });
    expect(valid?.id).toBe(tmpl.id);

    const extraBaseDot = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `extra.my-thing.${correctHash}`,
    });
    expect(extraBaseDot).toBeNull();

    for (const suffix of [
      correctHash.slice(0, 4),
      `${correctHash}a`,
      "ABCDE",
      "!@#$%",
      "",
    ]) {
      const invalid = await resolveAgentTemplateByIdOrUrlSlug({
        idOrUrlSlug: `my-thing.${suffix}`,
      });
      expect(invalid).toBeNull();
    }
  });

  test("resolves duplicate base slugs by each owner's hash and rejects collisions", async () => {
    await createAccount({ id: OTHER_OWNER_ID });
    const [tmplA, tmplB] = await Promise.all([
      createTemplate({
        slug: "shared",
        ownerAccountId: ADMIN_ACCOUNT_ID,
      }),
      createTemplate({
        slug: "shared",
        ownerAccountId: OTHER_OWNER_ID,
      }),
    ]);

    const hashA = hashId(tmplA.id);
    const hashB = hashId(tmplB.id);

    const rowA = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `shared.${hashA}`,
    });
    expect(rowA?.id).toBe(tmplA.id);

    const rowB = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `shared.${hashB}`,
    });
    expect(rowB?.id).toBe(tmplB.id);

    const wrongHash = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `shared.${hashId(randomUUID())}`,
    });
    expect(wrongHash).toBeNull();

    const collision = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: "shared.zzzzz",
      hasher: () => "zzzzz",
    });
    expect(collision).toBeNull();
  });

  test("enforces public status visibility for both id and hashed-slug inputs", async () => {
    const draft = await createTemplate({
      slug: "resolver-draft",
      status: "draft",
      firstPublishedAt: null,
    });
    const unlisted = await createTemplate({
      slug: "resolver-unlisted",
      status: "unlisted",
    });
    const archived = await createTemplate({
      slug: "resolver-archived",
      status: "archived",
    });

    const draftById = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: draft.id,
    });
    expect(draftById).toBeNull();

    const draftByHash = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `resolver-draft.${hashId(draft.id)}`,
    });
    expect(draftByHash).toBeNull();

    const visibleFixtures = [
      { tmpl: unlisted, slug: "resolver-unlisted", status: "unlisted" },
      { tmpl: archived, slug: "resolver-archived", status: "archived" },
    ] as const;

    for (const fixture of visibleFixtures) {
      const byId = await resolveAgentTemplateByIdOrUrlSlug({
        idOrUrlSlug: fixture.tmpl.id,
      });
      expect(byId?.status).toBe(fixture.status);

      const byHash = await resolveAgentTemplateByIdOrUrlSlug({
        idOrUrlSlug: `${fixture.slug}.${hashId(fixture.tmpl.id)}`,
      });
      expect(byHash?.status).toBe(fixture.status);
    }
  });

  test("rejects hashes from different ids", async () => {
    const tmplPrefixedSlug = await createTemplate({
      slug: "something-inside",
    });
    const tmplHashA = await createTemplate({
      slug: "aaa",
    });
    const tmplHashB = await createTemplate({
      slug: "bbb",
    });

    // Hashed slug with matching id resolves correctly
    const prefixedSlug = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `something-inside.${hashId(tmplPrefixedSlug.id)}`,
    });
    expect(prefixedSlug?.id).toBe(tmplPrefixedSlug.id);

    // Direct UUID lookup still works
    const prefixedId = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: tmplPrefixedSlug.id,
    });
    expect(prefixedId?.id).toBe(tmplPrefixedSlug.id);

    // Hash from tmplHashA on slug "bbb" (which belongs to tmplHashB) → null
    const hashAOnB = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `bbb.${hashId(tmplHashA.id)}`,
    });
    expect(hashAOnB).toBeNull();

    // Hash from tmplHashB on slug "aaa" (which belongs to tmplHashA) → null
    const hashBOnA = await resolveAgentTemplateByIdOrUrlSlug({
      idOrUrlSlug: `aaa.${hashId(tmplHashB.id)}`,
    });
    expect(hashBOnA).toBeNull();
  });
});
