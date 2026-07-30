import { Prisma } from "@prisma/client";
import { getBalance, getBalances, isAllowedFromBalance } from "@/payments";
import { prisma } from "@/utils/prisma";

/**
 * AgentInstance bookkeeping + the owner-computed agent power read (CON-807).
 *
 * The backend is the authority on who PAYS for an agent: `ownerAccountId` is
 * stamped from the joining user's JWT at dispatch (`join.ts`) and forwarded to
 * the assistant control plane, whose runtime then spends against that account
 * (`GET/POST /v2/accounts/:accountId/credits*`, gated by
 * `isSpendAllowed` semantics). Recording the same fact locally is what lets
 * client-facing payloads carry a viewer-independent `agentPowerDepleted`
 * field: "this agent's payer cannot fund a turn right now" — the OWNER's
 * wallet, never the viewer's.
 *
 * `agentPowerDepleted` MUST stay the exact negation of the runtime spend
 * gate: `isSpendAllowed` = balance >= reservedMaxTurnCredits
 * (src/payments/spendable.ts). Here that is `!isAllowedFromBalance(balance)`
 * over balances read from the ledger wallet (`getBalance`/`getBalances`, the
 * single source of truth).
 */

/** Wire shape of one agent entry on the conversation participation payload. */
export type ConversationAgentPower = {
  /** The agent's XMTP inbox id — the key clients match members against. */
  inboxId: string;
  /**
   * true ⇔ the agent's payer cannot fund a turn right now. Owner-computed and
   * viewer-independent: every member of the conversation sees the same value.
   */
  agentPowerDepleted: boolean;
};

/**
 * Record a dispatched agent. Called from the join handler right after the
 * control plane hands back an instanceId. An idempotent join retry
 * re-dispatches the same instanceId (the client idempotencyKey becomes the
 * Workflow instance id upstream), so the row may already exist.
 *
 * EVERY identity fact is write-once — first writer wins:
 * - ownerAccountId is never updated after creation, so a later dispatch that
 *   adopts the same upstream instance (idempotencyKey replay) can never
 *   reassign who pays. Keys are client-minted UUIDs, so a cross-account
 *   replay requires stealing an in-flight key; even then, only this advisory
 *   display bit could be mislabeled — the control plane recorded its own
 *   ownerAccountId at first dispatch and the runtime spends against THAT,
 *   never against this row.
 * - conversationId only fills a null, and from a dispatch only when the
 *   caller IS the recorded payer — so a replayed dispatch can neither
 *   relocate the agent's entry into another conversation's participation
 *   payload nor pre-claim an invite-join's conversation from a foreign
 *   account. The runtime's own status rows (matched by instanceId) remain
 *   the canonical fill path for invite joins.
 */
export async function recordAgentInstanceDispatched(args: {
  instanceId: string;
  ownerAccountId: string;
  conversationId: string | null;
}): Promise<void> {
  const { instanceId, ownerAccountId, conversationId } = args;
  try {
    await prisma.agentInstance.create({
      data: { instanceId, ownerAccountId, conversationId },
    });
  } catch (error) {
    const isExistingRow =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";
    if (!isExistingRow) throw error;
    // Replay of a known instance: fill a still-null conversationId, touch
    // nothing else — and only when the replaying caller is the recorded
    // payer, so a foreign replay cannot claim the conversation slot.
    if (conversationId !== null) {
      await prisma.agentInstance.updateMany({
        where: { instanceId, ownerAccountId, conversationId: null },
        data: { conversationId },
      });
    }
  }
}

/**
 * Fill in what a runtime status row taught us (inboxId and, for invite joins,
 * conversationId). Both are write-once facts — an agent's inbox and target
 * conversation never change — so only null columns are filled and redundant
 * polls turn into no-op UPDATEs matching zero rows. Update-only: a status for
 * an instance the backend never recorded (pre-table dispatches) matches
 * nothing, because a row without an owner would be unusable anyway.
 */
export async function recordAgentInstanceStatus(args: {
  instanceId: string;
  inboxId: string | null;
  conversationId: string | null;
}): Promise<void> {
  const { instanceId, inboxId, conversationId } = args;
  if (inboxId === null && conversationId === null) return;
  if (inboxId !== null) {
    await prisma.agentInstance.updateMany({
      where: { instanceId, inboxId: null },
      data: { inboxId },
    });
  }
  if (conversationId !== null) {
    await prisma.agentInstance.updateMany({
      where: { instanceId, conversationId: null },
      data: { conversationId },
    });
  }
}

/**
 * The conversation's agents with their owner-computed power state, for the
 * participation payload. Viewer-independent by construction: the caller's
 * identity is never an input.
 *
 * Batched: one AgentInstance read + one balance read for the DISTINCT owners
 * (getBalances), whatever the number of agents — no per-agent query.
 *
 * Agents whose inboxId is still unknown (registration in flight) are
 * excluded: clients bind by inboxId, so an entry without one is unusable.
 */
export async function listConversationAgentPower(
  conversationId: string,
): Promise<ConversationAgentPower[]> {
  const rows = await prisma.agentInstance.findMany({
    where: { conversationId, inboxId: { not: null } },
    select: { inboxId: true, ownerAccountId: true },
    // Deterministic order (join order, inboxId tiebreak within a same-ms
    // batch) so identical state always serializes identically.
    orderBy: [{ createdAt: "asc" }, { inboxId: "asc" }],
  });
  if (rows.length === 0) return [];

  const owners = [...new Set(rows.map((row) => row.ownerAccountId))];
  const balances = await getBalances(owners);

  return rows.map((row) => ({
    // Non-null by the where clause; Prisma's select type can't narrow it.
    inboxId: row.inboxId as string,
    agentPowerDepleted: !isAllowedFromBalance(
      balances.get(row.ownerAccountId) ?? 0n,
    ),
  }));
}

/**
 * Join-status enrichment in one read: load the row once, fill any null
 * identity facts (a write happens only when a null actually transitions —
 * polling a settled row costs one SELECT and zero UPDATEs, so the polling
 * endpoint cannot amplify write load), and return the owner-computed power
 * state. Returns null when the instance is unknown to the backend — callers
 * omit the field rather than guessing.
 */
export async function recordStatusAndGetAgentPower(args: {
  instanceId: string;
  inboxId: string | null;
  conversationId: string | null;
}): Promise<boolean | null> {
  const { instanceId, inboxId, conversationId } = args;
  const row = await prisma.agentInstance.findUnique({
    where: { instanceId },
    select: { ownerAccountId: true, inboxId: true, conversationId: true },
  });
  if (!row) return null;
  if (inboxId !== null && row.inboxId === null) {
    await prisma.agentInstance.updateMany({
      where: { instanceId, inboxId: null },
      data: { inboxId },
    });
  }
  if (conversationId !== null && row.conversationId === null) {
    await prisma.agentInstance.updateMany({
      where: { instanceId, conversationId: null },
      data: { conversationId },
    });
  }
  return !isAllowedFromBalance(await getBalance(row.ownerAccountId));
}
