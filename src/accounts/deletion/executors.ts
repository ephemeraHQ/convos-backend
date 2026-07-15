import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { DeletionTaskKind } from "@/accounts/deletion/service";
import { createComposioService } from "@/api/v2/connections/composio.service";
import { POSTHOG_HOST, POSTHOG_PROJECT_TOKEN } from "@/config";
import { createNotificationClient } from "@/notifications/client";
import { AppError } from "@/utils/errors";
import logger from "@/utils/logger";

/**
 * External-purge executors for the deletion outbox. One executor per
 * DeletionTask.kind; each takes the task payload snapshotted by the teardown
 * and removes the account's footprint in one external system. Executors must
 * be idempotent — the drain retries them until they succeed.
 */

export type DeletionExecutor = (payload: unknown) => Promise<void>;

const s3PayloadSchema = z.union([
  z.object({ target: z.literal("public"), url: z.string().min(1) }),
  z.object({ target: z.literal("private"), key: z.string().min(1) }),
]);

const installationPayloadSchema = z.object({
  installationId: z.string().min(1),
});

const composioPayloadSchema = z.object({ accountId: z.string().min(1) });

const posthogPayloadSchema = z.object({ distinctId: z.string().min(1) });

let _s3Client: S3Client | null = null;
const getS3Client = (): S3Client => {
  _s3Client = _s3Client ?? new S3Client({});
  return _s3Client;
};

/** S3 object removal. Deleting a nonexistent key succeeds (S3 semantics). */
const executeS3Object: DeletionExecutor = async (payload) => {
  const parsed = s3PayloadSchema.parse(payload);
  let bucket: string;
  let key: string;
  if (parsed.target === "public") {
    bucket = process.env.PUBLIC_ASSETS_BUCKET ?? "";
    key = new URL(parsed.url).pathname.replace(/^\//, "");
  } else {
    bucket = process.env.PRIVATE_ASSETS_BUCKET ?? "";
    key = parsed.key;
  }
  if (!bucket) {
    throw new AppError(
      503,
      `S3 bucket for ${parsed.target} assets not configured`,
    );
  }
  if (!key) {
    // Nothing addressable (e.g. an avatar URL with no path) — done.
    return;
  }
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
};

const notificationClient = createNotificationClient();

/** Remove one notification-server installation (per ClientIdentifier). */
const executeNotificationInstallation: DeletionExecutor = async (payload) => {
  const parsed = installationPayloadSchema.parse(payload);
  await notificationClient.deleteInstallation({
    installationId: parsed.installationId,
  });
};

/**
 * Composio purge. Post-commit re-discovery by design: connected accounts can
 * exist with no local grant rows, so the executor enumerates remotely via
 * list-for-user and deletes everything found, re-listing until the account
 * comes back empty. When Composio isn't configured there is nothing remote
 * to purge.
 */
const executeComposioUser: DeletionExecutor = async (payload) => {
  const parsed = composioPayloadSchema.parse(payload);
  const service = createComposioService();
  if (!service) return;
  // Bounded re-list loop: each pass deletes what the previous list returned.
  for (let pass = 0; pass < 5; pass += 1) {
    const list = await service.listForUser(parsed.accountId);
    const items: Array<{ id: string }> = list.items;
    if (items.length === 0) return;
    for (const item of items) {
      await service.delete(item.id);
    }
  }
  throw new AppError(
    502,
    "Composio connections still present after 5 purge passes",
  );
};

/**
 * PostHog person deletion. Ingestion tokens cannot delete persons; this uses
 * the private API and needs POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID.
 * When analytics is disabled entirely (no project token) there is no person
 * to delete; when analytics is on but the deletion credentials are missing,
 * the task fails and retries so the gap pages an operator instead of being
 * silently dropped.
 */
const executePosthogPerson: DeletionExecutor = async (payload) => {
  const parsed = posthogPayloadSchema.parse(payload);
  if (!POSTHOG_PROJECT_TOKEN) return;
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim() ?? "";
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim() ?? "";
  if (!personalApiKey || !projectId) {
    throw new AppError(
      503,
      "PostHog person deletion not configured (POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID)",
    );
  }
  const base = `${POSTHOG_HOST}/api/projects/${projectId}`;
  const headers = { Authorization: `Bearer ${personalApiKey}` };
  const lookup = await fetch(
    `${base}/persons/?distinct_id=${encodeURIComponent(parsed.distinctId)}`,
    { headers },
  );
  if (!lookup.ok) {
    throw new AppError(502, `PostHog person lookup failed: ${lookup.status}`);
  }
  const bodyJson = (await lookup.json()) as {
    results?: Array<{ id?: string | number }>;
  };
  const person = bodyJson.results?.[0];
  if (!person?.id) {
    // No person recorded for this distinct id — nothing to delete.
    return;
  }
  const del = await fetch(`${base}/persons/${person.id}/?delete_events=true`, {
    method: "DELETE",
    headers,
  });
  // 404 = already deleted (idempotent replay).
  if (!del.ok && del.status !== 404) {
    throw new AppError(502, `PostHog person deletion failed: ${del.status}`);
  }
  logger.info({ personId: person.id }, "deletion.purge.posthog_person_deleted");
};

const defaultExecutors: Record<DeletionTaskKind, DeletionExecutor> = {
  s3_object: executeS3Object,
  notification_installation: executeNotificationInstallation,
  composio_user: executeComposioUser,
  posthog_person: executePosthogPerson,
};

let _executors: Record<DeletionTaskKind, DeletionExecutor> = defaultExecutors;

export const getDeletionExecutor = (
  kind: string,
): DeletionExecutor | undefined => _executors[kind as DeletionTaskKind];

/** Test seam: override some/all executors, or pass null to restore defaults. */
export const __setDeletionExecutorsForTests = (
  overrides: Partial<Record<DeletionTaskKind, DeletionExecutor>> | null,
): void => {
  _executors =
    overrides === null
      ? defaultExecutors
      : { ...defaultExecutors, ...overrides };
};
