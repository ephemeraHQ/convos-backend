-- CreateTable
CREATE TABLE "InviteCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "batchLabel" VARCHAR(255),

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE INDEX "InviteCode_batchLabel_idx" ON "InviteCode"("batchLabel");

-- CreateIndex
CREATE INDEX "InviteCode_redeemedAt_idx" ON "InviteCode"("redeemedAt");
