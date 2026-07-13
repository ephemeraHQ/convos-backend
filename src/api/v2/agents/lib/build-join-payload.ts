import type { AgentTemplate } from "@prisma/client";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";

// Wire shape for the `template` field on `/api/assistants` — the full
// AgentTemplate JSON minus `ownerAccountId` and `featuredRank`. The runtime
// persists this verbatim as its on-disk `TEMPLATE.json` and needs neither:
// not who owns its template (the catalog row keeps `ownerAccountId`
// server-side for authorization checks), nor where the template sits in the
// website's featured gallery (a control-plane curation weight).
export type TemplateForWire = Omit<
  ReturnType<typeof serializeAgentTemplate>,
  "ownerAccountId" | "owner" | "featuredRank"
>;

export type JoinPayload = {
  template: TemplateForWire;
  ownerAccountId: string;
};

/**
 * Build the template-bearing portion of the `/api/assistants` request
 * body from a resolved AgentTemplate.
 *
 * Three transforms — that's the whole job:
 *  - Strip the template's own `ownerAccountId` (runtime never needs to
 *    know who owns its template).
 *  - Strip `featuredRank` (gallery curation weight; the runtime has no
 *    use for it and `TEMPLATE.json` stays free of control-plane state).
 *  - Pair the stripped template with the **joining user's** accountId,
 *    which the runtime later asserts back to the backend when creating
 *    templates the user owns mid-conversation.
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
    featuredRank: _templateFeaturedRank,
    ...template
  } = serialized;

  return {
    template,
    ownerAccountId: args.joiningUserAccountId,
  };
}
