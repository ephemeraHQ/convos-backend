import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type HmacKey } from "@xmtp/node-sdk";
import { z } from "zod";
import { NOTIFICATION_SERVER_URL } from "@/config";
import {
  Notifications,
  Subscription_HmacKeySchema,
  SubscriptionSchema,
  type Subscription,
} from "@/gen/notifications/v1/service_pb";

export function createNotificationClient() {
  const transport = createConnectTransport({
    baseUrl: NOTIFICATION_SERVER_URL,
    httpVersion: "1.1",
  });
  return createClient(Notifications, transport);
}

export type Topic = {
  topic: string;
  hmacKeys: HmacKey[];
};

// Zod schema for webhook notification validation
export const webhookNotificationBodySchema = z.object({
  idempotency_key: z.string(),
  message: z.object({
    content_topic: z.string(),
    timestamp_ns: z.string(),
    message: z.string(),
  }),
  message_context: z.object({
    message_type: z.string(),
    should_push: z.boolean().optional(),
  }),
  installation: z.object({
    id: z.string(),
    delivery_mechanism: z.object({
      kind: z.string(),
      token: z.string(),
    }),
  }),
  subscription: z.object({
    created_at: z.string(),
    topic: z.string(),
    is_silent: z.boolean(),
  }),
});

export type WebhookNotificationBody = z.infer<
  typeof webhookNotificationBodySchema
>;

export async function subscribeToTopics(
  // The installationId we want to apply the subscription to
  installationId: string,
  // A notifications server client, like the one generated above.
  notificationClient: ReturnType<typeof createNotificationClient>,
  topics: Topic[],
) {
  // convert topics to subscriptions
  const subscriptions = topics.map(
    (topic): Subscription =>
      create(SubscriptionSchema, {
        topic: topic.topic,
        isSilent: false,
        hmacKeys: topic.hmacKeys.map((v) =>
          create(Subscription_HmacKeySchema, {
            thirtyDayPeriodsSinceEpoch: Number(v.epoch),
            key: Uint8Array.from(v.key),
          }),
        ),
      }),
  );

  await notificationClient.subscribeWithMetadata({
    installationId,
    subscriptions,
  });
}
