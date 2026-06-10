-- CreateTable
CREATE TABLE "TelemetryBatch" (
    "batchId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryBatch_pkey" PRIMARY KEY ("batchId")
);

-- CreateIndex
CREATE INDEX "TelemetryBatch_receivedAt_idx" ON "TelemetryBatch"("receivedAt");
