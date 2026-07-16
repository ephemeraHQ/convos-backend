import type { Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";

const INSTALLATION_ADVISORY_LOCK_CLASS_ID = 7_282;
export const NOTIFICATION_MUTATION_RPC_TIMEOUT_MS = 10_000;
const INSTALLATION_MUTATION_TRANSACTION_TIMEOUT_MS = 15_000;

export type InstallationGeneration = {
  accountId: string | null;
  deviceAccountId: string | null;
  deviceId: string;
  updatedAt: Date;
};

export type InstallationExpectation =
  | { state: "absent" }
  | { generation: InstallationGeneration; state: "present" };

export const notificationMutationCallOptions = () => ({
  signal: AbortSignal.timeout(NOTIFICATION_MUTATION_RPC_TIMEOUT_MS),
  timeoutMs: NOTIFICATION_MUTATION_RPC_TIMEOUT_MS,
});

export const lockNotificationInstallation = async (
  tx: Prisma.TransactionClient,
  installationId: string,
): Promise<void> => {
  await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(
      ${INSTALLATION_ADVISORY_LOCK_CLASS_ID}::int,
      hashtext(${`notification-subscribe:${installationId}`})::int
    )
  `;
};

const generationMatches = (
  current: InstallationGeneration,
  expected: InstallationGeneration,
): boolean =>
  current.accountId === expected.accountId &&
  current.deviceAccountId === expected.deviceAccountId &&
  current.deviceId === expected.deviceId &&
  current.updatedAt.getTime() === expected.updatedAt.getTime();

export const withInstallationMutationFence = async <T>(args: {
  expectation: InstallationExpectation;
  installationId: string;
  mutate: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<
  | { applied: false; current: InstallationGeneration | null }
  | { applied: true; value: T }
> =>
  prisma.$transaction(
    async (tx) => {
      // One pooled connection is retained only for this installation and one
      // deadline-bounded remote mutation. No Account lock is held, and the
      // 10-second RPC bound stays below the 15-second transaction bound.
      await lockNotificationInstallation(tx, args.installationId);
      const row = await tx.clientIdentifier.findUnique({
        where: { id: args.installationId },
        select: {
          accountId: true,
          deviceId: true,
          updatedAt: true,
          device: { select: { accountId: true } },
        },
      });
      const current = row
        ? {
            accountId: row.accountId,
            deviceAccountId: row.device.accountId,
            deviceId: row.deviceId,
            updatedAt: row.updatedAt,
          }
        : null;
      const matches =
        args.expectation.state === "absent"
          ? current === null
          : current !== null &&
            generationMatches(current, args.expectation.generation);
      if (!matches) return { applied: false as const, current };
      return { applied: true as const, value: await args.mutate(tx) };
    },
    {
      maxWait: 5_000,
      timeout: INSTALLATION_MUTATION_TRANSACTION_TIMEOUT_MS,
    },
  );
