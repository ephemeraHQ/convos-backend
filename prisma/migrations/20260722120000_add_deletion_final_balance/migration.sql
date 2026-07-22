-- Display-only snapshot of the wallet balance at deletion time (pre-escrow).
-- Nullable: records written before this field existed stay null.
ALTER TABLE "DeletionRecord" ADD COLUMN "finalBalanceCredits" BIGINT;
