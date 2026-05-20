import type { Account, AgentTemplate } from "@prisma/client";
import { templatePublicUrl } from "./template-url";

export const serializeAccount = (account: Account) => ({
  object: "account",
  id: account.id,
  createdAt: account.createdAt.toISOString(),
});

// `template.slug` is the BASE slug ("brewski"); public URLs use the HASHED
// form ("brewski.x4f9k") that the resolver in
// `lib/resolve-id-or-hashed-slug.ts` matches against. Single server-side
// source for URL format — clients (iOS, runtime, web) read this field
// rather than rebuilding the URL from `slug`. `null` for drafts.
const publishedUrlFor = (template: AgentTemplate): string | null => {
  if (template.status === "draft") return null;
  return templatePublicUrl(template.slug, template.id);
};

/**
 * Pure formatter — must NOT perform I/O. Pass related rows through
 * `options`.
 *
 * Called per-row inside the list handler's `page.map(...)`, so any
 * Prisma call added inside this function would turn a single bounded
 * query into an N+1 fan-out. For list endpoints, materialise relations
 * via Prisma's `include` on the initial `findMany` and read them off
 * each row before calling this; do not call this from inside an async
 * map.
 */
export const serializeAgentTemplate = (
  template: AgentTemplate,
  options: { includeSkills?: boolean; owner?: Account } = {},
) => ({
  object: "agent_template",
  id: template.id,
  slug: template.slug,
  ...(options.owner === undefined
    ? { ownerAccountId: template.ownerAccountId }
    : { owner: serializeAccount(options.owner) }),
  forkedFromId: template.forkedFromId,
  agentName: template.agentName,
  description: template.description,
  prompt: template.prompt,
  category: template.category,
  emoji: template.emoji,
  avatarUrl: template.avatarUrl,
  tools: template.tools,
  connections: template.connections,
  version: template.version,
  firstPublishedAt: template.firstPublishedAt?.toISOString() ?? null,
  publishedUrl: publishedUrlFor(template),
  status: template.status,
  featured: template.featured,
  createdAt: template.createdAt.toISOString(),
  ...(options.includeSkills === true ? { skills: [] } : {}),
});
