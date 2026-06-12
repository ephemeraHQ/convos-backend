-- Consent records for backend-mediated Composio tool execution (fork Y).
--
-- iOS issues one row per approved capability request; POST /v2/composio/exec
-- reads them to authorize an agent call, then resolves the connection and calls
-- Composio server-side. ownerAccountId is stamped from the issuer's JWT, so an
-- owner can only grant access to their own connections. connectionId is the
-- Composio bearer capability — stored backend-side, never returned to an agent.

-- CreateTable
CREATE TABLE "ConnectionGrant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerAccountId" UUID NOT NULL,
    "ownerInboxId" TEXT NOT NULL,
    "granteeInboxId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "toolkit" TEXT NOT NULL,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectionId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one grant per (owner, grantee, conversation, toolkit) — re-issue upserts
CREATE UNIQUE INDEX "ConnectionGrant_ownerAccountId_granteeInboxId_conversationI_key" ON "ConnectionGrant"("ownerAccountId", "granteeInboxId", "conversationId", "toolkit");

-- CreateIndex: exec lookup by (grantee, conversation)
CREATE INDEX "ConnectionGrant_granteeInboxId_conversationId_idx" ON "ConnectionGrant"("granteeInboxId", "conversationId");

-- CreateIndex: owner list/revoke
CREATE INDEX "ConnectionGrant_ownerAccountId_idx" ON "ConnectionGrant"("ownerAccountId");

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
