import type { PublishStatus } from "@prisma/client";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { hashId } from "@/utils/url-slug";

const visibleStatuses = [
  "published",
  "unlisted",
  "archived",
] satisfies PublishStatus[];

const hashPattern = /^[0-9a-z]{5}$/;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveAgentTemplateByIdOrUrlSlug(args: {
  idOrUrlSlug: string;
  hasher?: (id: string) => string;
}) {
  const hasher = args.hasher ?? hashId;

  if (uuidPattern.test(args.idOrUrlSlug)) {
    return prisma.agentTemplate.findFirst({
      where: {
        id: args.idOrUrlSlug,
        status: { in: visibleStatuses },
      },
    });
  }

  const lastDotIndex = args.idOrUrlSlug.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return null;
  }

  const baseSlug = args.idOrUrlSlug.slice(0, lastDotIndex);
  const hash = args.idOrUrlSlug.slice(lastDotIndex + 1);

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
    (candidate) => hasher(candidate.id) === hash,
  );

  if (matches.length > 1) {
    // Two rows share both the base slug AND the 5-char hash. pickCollisionFreeId
    // is supposed to make this impossible at insert time; if it surfaces here,
    // the URL is genuinely ambiguous and we 404 rather than guess. Log it so a
    // real hash collision is visible in monitoring instead of failing silently.
    logger.error(
      {
        baseSlug,
        hash,
        matchedIds: matches.map((match) => match.id),
      },
      "[resolve-agent-template] url-slug collision: multiple rows match base slug + hash",
    );
    return null;
  }

  if (matches.length !== 1) {
    return null;
  }

  return matches[0] ?? null;
}
