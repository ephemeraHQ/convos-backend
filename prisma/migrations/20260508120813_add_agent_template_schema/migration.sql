-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('draft', 'published', 'unlisted', 'archived');

-- CreateTable
CREATE TABLE "AgentTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "ownerAccountId" UUID NOT NULL,
    "forkedFromId" UUID,
    "agentName" TEXT NOT NULL,
    "description" TEXT,
    "prompt" TEXT NOT NULL,
    "category" TEXT,
    "emoji" TEXT,
    "avatarUrl" TEXT,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "firstPublishedAt" TIMESTAMP(3),
    "status" "PublishStatus" NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTemplate_slug_idx" ON "AgentTemplate"("slug");

-- CreateIndex
CREATE INDEX "AgentTemplate_status_createdAt_id_idx" ON "AgentTemplate"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AgentTemplate_status_category_createdAt_id_idx" ON "AgentTemplate"("status", "category", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AgentTemplate_status_featured_createdAt_id_idx" ON "AgentTemplate"("status", "featured", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AgentTemplate_forkedFromId_idx" ON "AgentTemplate"("forkedFromId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_ownerAccountId_slug_key" ON "AgentTemplate"("ownerAccountId", "slug");

-- AddForeignKey
ALTER TABLE "AgentTemplate" ADD CONSTRAINT "AgentTemplate_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTemplate" ADD CONSTRAINT "AgentTemplate_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "AgentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
