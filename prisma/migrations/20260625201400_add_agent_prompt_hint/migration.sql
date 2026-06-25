-- CreateTable
CREATE TABLE "AgentPromptHint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "text" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPromptHint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPromptHint_published_sortOrder_idx" ON "AgentPromptHint"("published", "sortOrder");
