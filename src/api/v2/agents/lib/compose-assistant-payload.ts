import type { AgentTemplate } from "@prisma/client";
import { serializeAgentTemplate } from "@/api/v2/agent-templates/lib/serialize-agent-template";

export type CallerOverrides = {
  name?: string;
  profileImage?: string;
};

// Shape produced by the composer. The wire on `/api/assistants` keeps
// `instructions` and `metadata` as separate fields (legacy of the worker
// surface); the worker recomposes them into a single AgentTemplate before
// passing to `/convos/init`, which is what lands on disk as `TEMPLATE.json`.
//
// `ownerAccountId` here is the *joining user's* account — distinct from
// `AgentTemplate.ownerAccountId` (the template's owner). The joining user
// becomes the owner of any templates they build mid-conversation, so the
// runtime needs this value to authenticate `/generations` calls later.
export type ComposedAssistantPayload = {
  name: string;
  instructions: string;
  metadata: {
    template: Omit<
      ReturnType<typeof serializeAgentTemplate>,
      "prompt" | "ownerAccountId" | "owner"
    >;
  };
  ownerAccountId: string;
};

/**
 * Compose the `/api/assistants` request body from a resolved AgentTemplate.
 *
 * Caller-supplied `name` / `profileImage` overlay the template defaults
 * (template values are the floor; caller values win on collision). The
 * override applies to *both* the top-level `name` (used for the agent's
 * XMTP profile display name) and the `agentName`/`avatarUrl` fields inside
 * `metadata.template` (which lands on disk as `TEMPLATE.json` and so must
 * reflect the overridden values for downstream reads).
 *
 * Template's own `ownerAccountId` is stripped — the runtime never needs to
 * know who owns its template. The joining user's account rides separately
 * as `ownerAccountId` at the top level.
 */
export function composeAssistantPayload(args: {
  template: AgentTemplate;
  overrides?: CallerOverrides;
  joiningUserAccountId: string;
}): ComposedAssistantPayload {
  // `serializeAgentTemplate` returns either `{ ownerAccountId }` or
  // `{ owner }` depending on whether the caller asked it to expand the
  // owner relation — TS sees the return as a discriminated union. We never
  // pass `options.owner`, so the runtime always lands on the
  // `ownerAccountId` branch; widen the type so we can destructure it away.
  const serialized = serializeAgentTemplate(args.template) as ReturnType<
    typeof serializeAgentTemplate
  > & { ownerAccountId: string };
  const {
    prompt,
    ownerAccountId: _templateOwnerAccountId,
    ...templateMetadata
  } = serialized;

  const agentName = args.overrides?.name ?? args.template.agentName;
  const avatarUrl = args.overrides?.profileImage ?? args.template.avatarUrl;

  return {
    name: agentName,
    instructions: prompt,
    metadata: {
      template: { ...templateMetadata, agentName, avatarUrl },
    },
    ownerAccountId: args.joiningUserAccountId,
  };
}
