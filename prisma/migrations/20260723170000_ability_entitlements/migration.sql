-- Abilities (Connections V2) entitlement core
-- (docs/plans/abilities-entitlements.md).
--
-- Two tables replace the single-table V1 grant model as the backend-owned
-- source of truth for "who may do what where":
--
--   AbilityEntitlement   account <-> ability binding (credential scope).
--                        One row per (account, ability); connecting a service
--                        happens once per account.
--   ConversationAbility  an entitlement extended to ONE agent within ONE
--                        conversation (the reshaped ConnectionGrant). A second
--                        agent joining a conversation does not inherit the
--                        first agent's access.
--
-- ConnectionGrant stays in place: during the migration window the V1
-- /v2/connections/* handlers run as adapters that keep it written (rolling
-- deploys may still have old replicas reading it) while every reader
-- (exec, the abilities catalog, the V2 endpoints) works off the new tables.
-- A boot-time backfill (see src/api/v2/abilities/backfill-entitlements.ts)
-- converges existing Composio connected accounts and live grants into them.

-- CreateTable
CREATE TABLE "AbilityEntitlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID NOT NULL,
    -- Stable ability id; equals the Composio toolkit slug for Composio-backed
    -- abilities. Stored as issued (V2 surfaces validate against the manifest
    -- catalog; V1-adapter writes carry the toolkit string the client sent).
    "abilityId" TEXT NOT NULL,
    -- Lifecycle status, server-owned. Plain text + CHECK below (house
    -- pattern, no Postgres enums).
    "status" TEXT NOT NULL,
    -- Backing Composio connected-account id. Bearer capability: backend-only,
    -- never served to any client or agent. Null when unknown (auth-less
    -- abilities, or the credential was torn down at revocation).
    "externalConnectionId" TEXT,
    -- Served composite ability version (manifest + service) at bind time.
    -- Audit/staleness only; enforcement always resolves against the current
    -- catalog. 0 when the ability was not in the catalog at bind time.
    "abilityVersion" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    -- Revocation tombstone: the row is kept for audit (status 'revoked'
    -- + revokedAt) while extensions are deleted and the external credential
    -- is destroyed.
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbilityEntitlement_pkey" PRIMARY KEY ("id")
);

-- Status domain. Text + CHECK instead of a Postgres enum so adding a status is
-- a plain constraint swap, not an enum migration. Mirrors the wire vocabulary
-- of GET /v2/abilities (docs/schemas/abilities.schema.json).
ALTER TABLE "AbilityEntitlement"
  ADD CONSTRAINT "AbilityEntitlement_status_check"
  CHECK ("status" IN ('pending_auth', 'active', 'needs_reauth', 'expired', 'revoked'));

-- CreateTable
CREATE TABLE "ConversationAbility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entitlementId" UUID NOT NULL,
    -- Opaque XMTP conversation id (no Conversation table), as with V1 grants.
    "conversationId" TEXT NOT NULL,
    -- The agent allowed to act (the V1 grant's granteeInboxId). Immutable
    -- inbox id, so access is tied to a provable identity.
    "agentInboxId" TEXT NOT NULL,
    -- Granted permission-bundle ids (e.g. 'calendar.events'); resolved to
    -- Composio actions against the CURRENT catalog at check time.
    "bundleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    -- Legacy V1 scope: explicit Composio action slugs carried 1:1 from
    -- ConnectionGrant.actions. Preserves V1 exec semantics exactly (empty
    -- actions + empty bundleIds = whole-toolkit transition default; a scoped
    -- list stays scoped). V2 surfaces never write it; drains with the V1
    -- adapters.
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    -- Who extended the opt-in (the member's XMTP inbox id; the V1 grant's
    -- ownerInboxId). Matched by the check's onBehalfOf selector. Nullable:
    -- V2 writes may not provide it.
    "extendedByInboxId" TEXT,
    -- Per-extension expiry carried from V1 grants (V1 clients may set it).
    -- Account-level expiry lives on the entitlement.
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationAbility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one entitlement per (account, ability) — re-binding upserts
CREATE UNIQUE INDEX "AbilityEntitlement_accountId_abilityId_key" ON "AbilityEntitlement"("accountId", "abilityId");

-- CreateIndex: the check path — resolve candidate rows for a trusted
-- (conversation, agent) pair
CREATE INDEX "ConversationAbility_conversationId_agentInboxId_idx" ON "ConversationAbility"("conversationId", "agentInboxId");

-- CreateIndex: one opt-in per (entitlement, conversation, agent) — re-extending
-- upserts
CREATE UNIQUE INDEX "ConversationAbility_entitlementId_conversationId_agentInbox_key" ON "ConversationAbility"("entitlementId", "conversationId", "agentInboxId");

-- AddForeignKey: account deletion tears down entitlements (and, via the next
-- FK, their extensions)
ALTER TABLE "AbilityEntitlement" ADD CONSTRAINT "AbilityEntitlement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting an entitlement row cascades its extensions
-- (revocation tombstones keep the row and delete extensions explicitly)
ALTER TABLE "ConversationAbility" ADD CONSTRAINT "ConversationAbility_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "AbilityEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
