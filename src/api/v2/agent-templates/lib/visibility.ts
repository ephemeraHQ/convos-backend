import type { Prisma } from "@prisma/client";

/**
 * Base "what can this caller see" filter for agent templates, mirroring the
 * visibility rules in the list handler (minus the optional status / owner /
 * search narrowing):
 *   - API key listener (admin): everything.
 *   - Anonymous: published only.
 *   - Authenticated user: published from anyone + their own non-published.
 *
 * Shared by the list and counts handlers so the two never drift.
 */
export function visibilityWhere(
  accountId: string | undefined,
  isApiKeyListener: boolean,
): Prisma.AgentTemplateWhereInput {
  if (isApiKeyListener) return {};
  if (accountId === undefined) return { status: "published" };
  return {
    OR: [
      { status: "published" },
      {
        status: { in: ["draft", "unlisted", "archived"] },
        ownerAccountId: accountId,
      },
    ],
  };
}
