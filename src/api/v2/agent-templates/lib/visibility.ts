import type { Prisma } from "@prisma/client";

/**
 * Base "what can this caller see" filter for agent templates:
 *   - API key listener (admin): everything.
 *   - Anonymous: published only.
 *   - Authenticated user: published from anyone + their own non-published.
 *
 * The single source of truth for visibility — the list handler composes the
 * optional status / category / owner / search narrowing on top of this, and
 * the counts handler aggregates over it, so the two never drift.
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
