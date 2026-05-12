-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "AgentTemplateGeneration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerAccountId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "templateId" UUID,
    "status" "GenerationStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTemplateGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplateGeneration_ownerAccountId_idempotencyKey_key" ON "AgentTemplateGeneration"("ownerAccountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentTemplateGeneration_ownerAccountId_idx" ON "AgentTemplateGeneration"("ownerAccountId");

-- CreateIndex
CREATE INDEX "AgentTemplateGeneration_status_updatedAt_idx" ON "AgentTemplateGeneration"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentTemplateGeneration_expiresAt_idx" ON "AgentTemplateGeneration"("expiresAt");

-- AddForeignKey
ALTER TABLE "AgentTemplateGeneration" ADD CONSTRAINT "AgentTemplateGeneration_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTemplateGeneration" ADD CONSTRAINT "AgentTemplateGeneration_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
