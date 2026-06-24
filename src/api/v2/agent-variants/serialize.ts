import type { AgentVariant } from "@prisma/client";

// Wire shape the dev app picker reads. Dates are emitted as ISO strings;
// everything else rides verbatim.
export function serializeAgentVariant(variant: AgentVariant) {
  return {
    slug: variant.slug,
    label: variant.label,
    whatToTest: variant.whatToTest,
    status: variant.status,
    assistantWorkerUrl: variant.assistantWorkerUrl,
    builderPromptSlug: variant.builderPromptSlug,
    prUrl: variant.prUrl,
    branch: variant.branch,
    commit: variant.commit,
    expiresAt: variant.expiresAt ? variant.expiresAt.toISOString() : null,
    createdAt: variant.createdAt.toISOString(),
  };
}
