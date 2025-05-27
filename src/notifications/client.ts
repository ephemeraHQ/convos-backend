import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type HmacKey } from "@xmtp/node-sdk";
import { Notifications } from "@/notifications/gen/notifications/v1/service_pb";

export function createNotificationClient() {
  if (!process.env.NOTIFICATION_SERVER_URL) {
    throw new Error("NOTIFICATION_SERVER_URL is not set");
  }
  const transport = createConnectTransport({
    baseUrl: process.env.NOTIFICATION_SERVER_URL,
    httpVersion: "1.1",
  });
  return createClient(Notifications, transport);
}

export type Topic = {
  topic: string;
  hmacKeys: HmacKey[];
};

export type NotificationResponse = {
  idempotency_key: string;
  message: {
    content_topic: string;
    timestamp_ns: string;
    message: string;
  };
  message_context: {
    message_type: string;
    should_push?: boolean;
  };
  installation: {
    id: string;
    delivery_mechanism: {
      kind: string;
      token: string;
    };
  };
  subscription: {
    created_at: string;
    topic: string;
    is_silent: boolean;
  };
};
