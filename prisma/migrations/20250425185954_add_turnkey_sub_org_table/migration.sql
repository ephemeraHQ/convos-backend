-- CreateTable
CREATE TABLE "SubOrg" (
    "id" TEXT NOT NULL,
    "defaultWalletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubOrg_pkey" PRIMARY KEY ("id")
);
