import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resolveAgentTemplateByIdOrHashedSlug } from "@/api/v2/agent-templates/lib/resolve-id-or-hashed-slug";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";
import { slugHash } from "@/utils/slug-hash";

const cleanup = async () => {
  await prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_" } },
  });
  await prisma.account.deleteMany({
    where: { id: { startsWith: "acct_test_" } },
  });
};

const createAccount = (id: string) =>
  prisma.account.upsert({
    where: { id },
    update: {},
    create: { id },
  });

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> & {
    id: string;
  },
) => {
  const slug = overrides.slug ?? overrides.id.replace(/_/g, "-");

  return prisma.agentTemplate.create({
    data: {
      id: overrides.id,
      slug,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${overrides.id}`,
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
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
  });

  test("resolves direct tmpl_ ids and never falls back to bare slug lookups", async () => {
    await createTemplate({
      id: "tmpl_test_resolver_id",
      slug: "unrelated",
    });
    await createTemplate({
      id: "tmpl_test_resolver_bare",
      slug: "brewski",
    });

    const byId = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: "tmpl_test_resolver_id",
    });
    expect(byId?.id).toBe("tmpl_test_resolver_id");

    const bareSlug = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: "brewski",
    });
    expect(bareSlug).toBeNull();
  });

  test("splits hashed slugs on the last dot and validates hash syntax exactly", async () => {
    await createTemplate({
      id: "tmpl_test_resolver_hash",
      slug: "my-thing",
    });

    const correctHash = slugHash("tmpl_test_resolver_hash");
    const valid = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `my-thing.${correctHash}`,
    });
    expect(valid?.id).toBe("tmpl_test_resolver_hash");

    const extraBaseDot = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `extra.my-thing.${correctHash}`,
    });
    expect(extraBaseDot).toBeNull();

    for (const suffix of [
      correctHash.slice(0, 4),
      `${correctHash}a`,
      "ABCDE",
      "!@#$%",
      "",
    ]) {
      const invalid = await resolveAgentTemplateByIdOrHashedSlug({
        idOrHashedSlug: `my-thing.${suffix}`,
      });
      expect(invalid).toBeNull();
    }
  });

  test("resolves duplicate base slugs by each owner's hash and rejects collisions", async () => {
    await createAccount("acct_test_resolver_owner");
    await Promise.all([
      createTemplate({
        id: "tmpl_test_shared_a",
        slug: "shared",
        ownerAccountId: ADMIN_ACCOUNT_ID,
      }),
      createTemplate({
        id: "tmpl_test_shared_b",
        slug: "shared",
        ownerAccountId: "acct_test_resolver_owner",
      }),
    ]);

    const hashA = slugHash("tmpl_test_shared_a");
    const hashB = slugHash("tmpl_test_shared_b");

    const rowA = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `shared.${hashA}`,
    });
    expect(rowA?.id).toBe("tmpl_test_shared_a");

    const rowB = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `shared.${hashB}`,
    });
    expect(rowB?.id).toBe("tmpl_test_shared_b");

    const wrongHash = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `shared.${slugHash("tmpl_test_shared_c")}`,
    });
    expect(wrongHash).toBeNull();

    const collision = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: "shared.zzzzz",
      slugHasher: () => "zzzzz",
    });
    expect(collision).toBeNull();
  });

  test("enforces public status visibility for both id and hashed-slug inputs", async () => {
    await Promise.all([
      createTemplate({
        id: "tmpl_test_resolver_draft",
        slug: "resolver-draft",
        status: "draft",
        firstPublishedAt: null,
      }),
      createTemplate({
        id: "tmpl_test_resolver_unlisted",
        slug: "resolver-unlisted",
        status: "unlisted",
      }),
      createTemplate({
        id: "tmpl_test_resolver_archived",
        slug: "resolver-archived",
        status: "archived",
      }),
    ]);

    const draftById = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: "tmpl_test_resolver_draft",
    });
    expect(draftById).toBeNull();

    const draftByHash = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `resolver-draft.${slugHash("tmpl_test_resolver_draft")}`,
    });
    expect(draftByHash).toBeNull();

    const visibleFixtures = [
      {
        id: "tmpl_test_resolver_unlisted",
        slug: "resolver-unlisted",
        status: "unlisted",
      },
      {
        id: "tmpl_test_resolver_archived",
        slug: "resolver-archived",
        status: "archived",
      },
    ] as const;

    for (const fixture of visibleFixtures) {
      const byId = await resolveAgentTemplateByIdOrHashedSlug({
        idOrHashedSlug: fixture.id,
      });
      expect(byId?.status).toBe(fixture.status);

      const byHash = await resolveAgentTemplateByIdOrHashedSlug({
        idOrHashedSlug: `${fixture.slug}.${slugHash(fixture.id)}`,
      });
      expect(byHash?.status).toBe(fixture.status);
    }
  });

  test("keeps tmpl_ anchored at the start and rejects hashes from different ids", async () => {
    await Promise.all([
      createTemplate({
        id: "tmpl_test_prefixed_slug",
        slug: "something-tmpl_inside",
      }),
      createTemplate({
        id: "tmpl_test_hash_a",
        slug: "aaa",
      }),
      createTemplate({
        id: "tmpl_test_hash_b",
        slug: "bbb",
      }),
    ]);

    const prefixedSlug = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `something-tmpl_inside.${slugHash(
        "tmpl_test_prefixed_slug",
      )}`,
    });
    expect(prefixedSlug?.id).toBe("tmpl_test_prefixed_slug");

    const prefixedId = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: "tmpl_test_prefixed_slug",
    });
    expect(prefixedId?.id).toBe("tmpl_test_prefixed_slug");

    const hashAOnB = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `bbb.${slugHash("tmpl_test_hash_a")}`,
    });
    expect(hashAOnB).toBeNull();

    const hashBOnA = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: `aaa.${slugHash("tmpl_test_hash_b")}`,
    });
    expect(hashBOnA).toBeNull();
  });
});
