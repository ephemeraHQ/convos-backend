-- CreateTable
CREATE TABLE "RuntimeConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeConfig_pkey" PRIMARY KEY ("key")
);
