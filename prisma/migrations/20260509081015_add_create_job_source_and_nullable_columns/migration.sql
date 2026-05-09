-- CreateEnum
CREATE TYPE "CreateJobSource" AS ENUM ('app', 'web', 'twitter');

-- AlterTable: add source, metadata, joinUrl, and instance columns to CreateJob
ALTER TABLE "CreateJob" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "inboxId" TEXT,
ADD COLUMN     "joinUrl" TEXT,
ADD COLUMN     "metadata" TEXT,
ADD COLUMN     "playgroundInstanceId" TEXT,
ADD COLUMN     "source" "CreateJobSource" NOT NULL DEFAULT 'app';
