import type { Request, Response } from "express";
import { z } from "zod";
import {
  deleteAccount,
  findDeletionRecordForAccount,
  type DeletionOutcome,
} from "@/accounts/deletion/service";
import { loadAccountDeletionEnabled } from "@/config";
import { accountIdSchema } from "@/utils/account-id";

const bodySchema = z.object({
  operationId: z.string().uuid(),
});

const serializeOutcome = (outcome: DeletionOutcome) => ({
  status: "deleted" as const,
  operationId: outcome.operationId,
  deletedAt: outcome.deletedAt.toISOString(),
  purgeWindowHours: outcome.purgeWindowHours,
});

/**
 * DELETE /v2/accounts/me — authenticated account deletion.
 *
 * Auth is endpoint-specific by design: authMiddleware validated the JWT
 * (signature + expiry), but requireAccount is deliberately not applied. A
 * validly-signed, unexpired token for an already-deleted account must reach
 * the deletion-record lookup so a retry converges on the stored 200 instead
 * of being bounced by fail-closed auth. That carve-out grants nothing beyond
 * "re-read own deletion record"; every other route stays fail-closed.
 *
 * Response contract: 200 with the stored record on success and on every
 * replay — including a replay with a different operationId, which echoes the
 * stored operationId (the client detects the prior deletion by the
 * mismatch).
 */
export async function accountDeleteHandler(req: Request, res: Response) {
  // Rollout barrier (ACCOUNT_DELETION_ENABLED env var). Deletion defaults
  // to DISABLED: a fresh replica must never delete accounts while older
  // replicas without the lineage/tombstone-aware verify/webhook code are
  // still serving. Ops flips the env var to "true" only after migrations
  // are complete and every replica runs this build; the same switch is the
  // emergency kill switch afterwards. Env is fixed at process start, so a
  // flip requires an infra PR + task-definition roll (no 30s config-cache
  // expiry) — accepted trade-off for a deploy-audited switch. Fail-closed:
  // unset or garbage reads as off.
  if (!loadAccountDeletionEnabled()) {
    req.log.warn({}, "account.delete.disabled");
    res
      .status(503)
      .json({ error: "Account deletion is temporarily unavailable" });
    return;
  }

  const accountIdParse = accountIdSchema.safeParse(res.locals.accountId);
  if (!accountIdParse.success) {
    req.log.warn(
      { accountIdPresent: res.locals.accountId !== undefined },
      "account.delete.no_account_claim",
    );
    res.status(403).json({ error: "Account required" });
    return;
  }
  const accountId = accountIdParse.data;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { issues: parsed.error.issues },
      "account.delete.invalid_body",
    );
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { operationId } = parsed.data;

  try {
    const outcome = await deleteAccount({ accountId, operationId });
    if (outcome) {
      req.log.info(
        { operationId: outcome.operationId },
        "account.delete.completed",
      );
      res.status(200).json(serializeOutcome(outcome));
      return;
    }

    // Account row is gone: idempotent-retry path. Resolve the stored record
    // (by keyed account ref) and re-return it, echoing the stored
    // operationId.
    const stored = await findDeletionRecordForAccount(accountId);
    if (stored) {
      req.log.info(
        {
          operationId: stored.operationId,
          operationIdMatched: stored.operationId === operationId,
        },
        "account.delete.replayed",
      );
      res.status(200).json(serializeOutcome(stored));
      return;
    }

    // No account and no deletion record (e.g. a token minted for an account
    // that never completed provisioning). Nothing to confirm — generic
    // fail-closed response; never deletion confirmation.
    req.log.warn({}, "account.delete.no_account_no_record");
    res.status(401).json({ error: "Unauthorized" });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "account.delete.failed",
    );
    res.status(500).json({ error: "Failed to delete account" });
    return;
  }
}
