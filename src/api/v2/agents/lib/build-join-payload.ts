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

export type JoinPayload = {
  template: TemplateForWire;
  ownerAccountId: string;
};

/**
 * Build the template-bearing portion of the `/api/assistants` request
 * body from a resolved AgentTemplate.
 *
 * Two transforms — that's the whole job:
 *  - Strip the template's own `ownerAccountId` (runtime never needs to
 *    know who owns its template).
 *  - Pair the stripped template with the **joining user's** accountId,
 *    which the runtime uses later to authenticate `/generations` calls
 *    in PR 3.
 *
 * Caller-supplied agent-identity overrides (`name`/`profileImage`) are
 * applied at the handler layer by spreading them onto the row before
 * calling here, so this stays a one-shot transform with a stable
 * snapshot-test surface.
 */
export function buildJoinPayload(args: {
  template: AgentTemplate;
  joiningUserAccountId: string;
}): JoinPayload {
  // `serializeAgentTemplate` returns either `{ ownerAccountId }` or
  // `{ owner }` depending on whether `options.owner` was passed — TS
  // sees the return as a discriminated union. We don't pass
  // `options.owner` here, but widening with `?: never`-style optionals
  // (rather than asserting one branch) means we strip *both* keys
  // unconditionally, so if a future maintainer changes the serializer's
  // default to emit `owner` we don't silently leak it onto the wire.
  const serialized = serializeAgentTemplate(args.template) as ReturnType<
    typeof serializeAgentTemplate
  > & {
    ownerAccountId?: string;
    owner?: unknown;
  };
  const {
    ownerAccountId: _templateOwnerAccountId,
    owner: _templateOwner,
    ...template
  } = serialized;

  return {
    template,
    ownerAccountId: args.joiningUserAccountId,
  };
}
