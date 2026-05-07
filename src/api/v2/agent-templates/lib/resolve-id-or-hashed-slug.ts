import type { PublishStatus } from "@prisma/client";
import { prisma } from "@/utils/prisma";
import { slugHash } from "@/utils/slug-hash";

const visibleStatuses = [
  "published",
  "unlisted",
  "archived",
] satisfies PublishStatus[];

const hashPattern = /^[0-9a-z]{5}$/;

export async function resolveAgentTemplateByIdOrHashedSlug(args: {
  idOrHashedSlug: string;
  slugHasher?: (id: string) => string;
}) {
  const slugHasher = args.slugHasher ?? slugHash;

  if (args.idOrHashedSlug.startsWith("tmpl_")) {
    return prisma.agentTemplate.findFirst({
      where: {
        id: args.idOrHashedSlug,
        status: { in: visibleStatuses },
      },
    });
  }

  const lastDotIndex = args.idOrHashedSlug.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return null;
  }

  const baseSlug = args.idOrHashedSlug.slice(0, lastDotIndex);
  const hash = args.idOrHashedSlug.slice(lastDotIndex + 1);

  if (!hashPattern.test(hash)) {
    return null;
  }

  const candidates = await prisma.agentTemplate.findMany({
    where: {
      slug: baseSlug,
      status: { in: visibleStatuses },
    },
  });
  const matches = candidates.filter(
    (candidate) => slugHasher(candidate.id) === hash,
  );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0] ?? null;
}
