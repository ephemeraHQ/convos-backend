import { z } from "zod";
import {
  ASSISTANT_API_KEY as CONFIG_API_KEY,
  ASSISTANT_API_URL as CONFIG_API_URL,
  ASSISTANT_JOIN_POLL_INTERVAL_MS as CONFIG_POLL_INTERVAL_MS,
  ASSISTANT_JOIN_WAIT_BUDGET_MS as CONFIG_WAIT_BUDGET_MS,
} from "@/config";

/**
 * Shared Zod schema for the upstream assistant runtime status response
 * (`GET /api/assistants/:instanceId`). Both `join.ts` (the server-side
 * poller) and `join-status.ts` (the client polling endpoint) parse this
 * shape; keeping the schema in one place prevents drift if upstream adds
 * or renames a field.
 */
export const joinStatusEnum = z.enum([
  "starting",
  "pending_acceptance",
  "joined",
  // The runtime marks an assistant "ready" once its container has booted —
  // strictly after "joined". Treat it as joined wherever joins are awaited;
  // leaving it out of the enum makes the status parse fail (502) for any
  // assistant polled after boot completes.
  "ready",
  "failed",
]);

export const assistantStatusSchema = z.object({
  instanceId: z.string(),
  joinStatus: joinStatusEnum,
  inboxId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  joinFailureReason: z.string().nullable().optional(),
  // Unix epoch ms from a D1 INTEGER column — JSON numbers, not strings.
  createdAt: z.number().optional(),
  destroyedAt: z.number().nullable().optional(),
});

export type AssistantStatus = z.infer<typeof assistantStatusSchema>;
export type JoinStatus = z.infer<typeof joinStatusEnum>;

/**
 * Test-only overrides for the assistant runtime config. Tests use
 * `__setAssistantConfigOverridesForTests({...})` to substitute values
 * per-test without resorting to `process.env` mutation (which doesn't
 * affect the module-load constants exported from `@/config`).
 *
 * Mirrors the pattern used by `__setBuilderModelOverrideForTests` in
 * `agent-templates/services/templateGen.ts`.
 */
type AssistantConfigOverrides = Partial<{
  assistantApiUrl: string;
  assistantApiKey: string;
  joinWaitBudgetMs: number;
  joinPollIntervalMs: number;
}>;

let _overrides: AssistantConfigOverrides = {};

export function getAssistantApiUrl(): string {
  return _overrides.assistantApiUrl ?? CONFIG_API_URL;
}

export function getAssistantApiKey(): string {
  return _overrides.assistantApiKey ?? CONFIG_API_KEY;
}

export function getJoinWaitBudgetMs(): number {
  return _overrides.joinWaitBudgetMs ?? CONFIG_WAIT_BUDGET_MS;
}

export function getJoinPollIntervalMs(): number {
  return _overrides.joinPollIntervalMs ?? CONFIG_POLL_INTERVAL_MS;
}

export function __setAssistantConfigOverridesForTests(
  overrides: AssistantConfigOverrides,
): void {
  _overrides = overrides;
}
