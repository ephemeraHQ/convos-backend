-- CreateEnum
CREATE TYPE "CreateJobStatus" AS ENUM ('pending', 'generating', 'provisioning', 'done', 'failed');

-- CreateTable
CREATE TABLE "CreateJob" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "status" "CreateJobStatus" NOT NULL DEFAULT 'pending',
    "input" TEXT NOT NULL,
    "ownerAccountId" UUID NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "CreateJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreateJob_status_createdAt_idx" ON "CreateJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CreateJob" ADD CONSTRAINT "CreateJob_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
