-- CreateTable
CREATE TABLE "AgentVariant" (
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "whatToTest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "assistantWorkerUrl" TEXT,
    "builderPromptSlug" TEXT,
    "prUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentVariant_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE INDEX "AgentVariant_status_createdAt_idx" ON "AgentVariant"("status", "createdAt");
