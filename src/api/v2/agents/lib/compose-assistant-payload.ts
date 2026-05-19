import type { AgentTemplate } from "@prisma/client";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";

// The on-disk `TEMPLATE.json` shape (see convos-assistants PR 1672) —
// the full AgentTemplate JSON minus `ownerAccountId`. The runtime
// doesn't need to know who owns its template; the catalog row still
// has it server-side for authorization checks.
export type TemplateForWire = Omit<
  ReturnType<typeof serializeAgentTemplate>,
  "ownerAccountId" | "owner"
>;

export type ComposedAssistantPayload = {
  template: TemplateForWire;
  ownerAccountId: string;
};

/**
 * Compose the template-bearing portion of the `/api/assistants` request
 * body from a resolved AgentTemplate.
 *
 * Pure function — no overrides, no merging, no derivation beyond
 * stripping `ownerAccountId` (the template's owner). Caller-supplied
 * agent-identity overrides (`name`/`profileImage`) are applied at the
 * handler layer by spreading them onto the row before composing, so
 * this stays a one-line transform.
 *
 * `ownerAccountId` on the return is the **joining user's** account —
 * distinct from the template's `ownerAccountId` (the template's owner).
 * The joining user becomes the owner of any templates they build mid-
 * conversation, so the runtime needs this value to authenticate
 * `/generations` calls in PR 3.
 */
export function composeAssistantPayload(args: {
  template: AgentTemplate;
  joiningUserAccountId: string;
}): ComposedAssistantPayload {
  // `serializeAgentTemplate` returns either `{ ownerAccountId }` or
  // `{ owner }` depending on whether the caller asked it to expand the
  // owner relation — TS sees the return as a discriminated union. We
  // never pass `options.owner`, so the runtime always lands on the
  // `ownerAccountId` branch; widen the type so we can destructure it.
  const serialized = serializeAgentTemplate(args.template) as ReturnType<
    typeof serializeAgentTemplate
  > & { ownerAccountId: string };
  const { ownerAccountId: _templateOwnerAccountId, ...template } = serialized;

  return {
    template,
    ownerAccountId: args.joiningUserAccountId,
  };
}
