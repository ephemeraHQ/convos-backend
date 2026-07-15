-- Shared-store rate-limit counters. The claim endpoint's global
-- claims-per-hour ceiling must hold across every replica; the default
-- express-rate-limit MemoryStore is per-process, so the global limiter is
-- backed by this table instead (Postgres is the one store every replica
-- already shares).

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE INDEX "RateLimitCounter_windowStart_idx" ON "RateLimitCounter"("windowStart");
