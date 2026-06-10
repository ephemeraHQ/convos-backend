import type { Request } from "express";

/**
 * The cryptographically-trusted caller of a POST /v2/composio/exec request.
 *
 * `agentInboxId` and `conversationId` MUST come from a signal the agent cannot
 * forge — not from the request body. The agent authenticates with the shared
 * agent API key, which proves "an agent is calling," not "for whom"; so the
 * exec authorization (grant lookup) must key off this trusted identity, never
 * off agent-supplied fields.
 */
export type TrustedCaller = {
  conversationId: string;
  /** The agent acting — matched against ConnectionGrant.granteeInboxId. */
  agentInboxId: string;
};

/**
 * Resolves the trusted caller for an exec request, or null when no trusted
 * signal is available (fail-closed → exec returns 403).
 *
 * Production has NO resolver wired yet: this backend cannot see Herald's
 * HMAC-signed sender or the conversation membership (no Herald client, no
 * membership table). Until that lands — the worker forwards Herald's signed
 * envelope and the backend re-verifies the HMAC — exec must fail closed rather
 * than trust an agent-named conversation/inbox. See
 * docs/plans/composio-exec-grant-mediation.md (Tier 2 sub-question).
 */
export type TrustedCallerResolver = (
  req: Request,
) => Promise<TrustedCaller | null>;

const FAIL_CLOSED: TrustedCallerResolver = () => Promise.resolve(null);

let resolver: TrustedCallerResolver = FAIL_CLOSED;

export function resolveTrustedCaller(
  req: Request,
): Promise<TrustedCaller | null> {
  return resolver(req);
}

/**
 * Override the resolver — used by tests to exercise the grant→Composio path
 * with a known trusted caller. Pass null to restore the fail-closed default.
 */
export function __setTrustedCallerResolverForTests(
  override: TrustedCallerResolver | null,
): void {
  resolver = override ?? FAIL_CLOSED;
}
