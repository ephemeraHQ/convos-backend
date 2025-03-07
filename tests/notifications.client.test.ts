import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import express, { type Request, type Response } from "express";
import { rimrafSync } from "rimraf";
import { jsonMiddleware } from "@/middleware/json";
import {
  createNotificationClient,
  type NotificationResponse,
} from "@/notifications/client";
import {
  buildConversationTopic,
  buildWelcomeTopic,
  isConversationTopic,
  isWelcomeTopic,
} from "@/notifications/topics";
import { AsyncStream } from "./AsyncStream";
import { createClient } from "./helpers";

describe("Notifications", () => {
  describe("topics", () => {
    it("should build and validate a welcome topic", () => {
      const topic = buildWelcomeTopic("foo");
      expect(topic).toBe("/xmtp/mls/1/w-foo/proto");
      expect(isWelcomeTopic(topic)).toBe(true);
    });

    it("should build and validate a conversation topic", () => {
      const topic = buildConversationTopic("bar");
      expect(topic).toBe("/xmtp/mls/1/g-bar/proto");
      expect(isConversationTopic(topic)).toBe(true);
    });
  });

  describe("subscriptions", () => {
    let app: express.Application;
    let server: Server;
    let stream: AsyncStream<NotificationResponse>;

    beforeEach(() => {
      app = express();
      app.use(jsonMiddleware);
      stream = new AsyncStream<NotificationResponse>();
      app.post("/", (req: Request, res: Response) => {
        void stream.callback(null, req.body as NotificationResponse);
        res.status(200).send("OK");
      });
      server = app.listen(8081);
    });

    afterEach(() => {
      server.close();
      // clean up the test databases
      rimrafSync("tests/**/*.db3*", { glob: true });
    });

    it("registers and unregisters an installation", async () => {
      const notificationClient = createNotificationClient();

      const registerResponse = await notificationClient.registerInstallation({
        installationId: "registration-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });
      expect(registerResponse.installationId).toBe("registration-test");
      expect(registerResponse.validUntil).toBeGreaterThan(0);

      await notificationClient.deleteInstallation({
        installationId: "registration-test",
      });
    });

    it("fails to register an installation with an invalid delivery mechanism", () => {
      const notificationClient = createNotificationClient();
      expect(
        notificationClient.registerInstallation({
          installationId: "invalid-delivery-mechanism-test",
        }),
      ).rejects.toThrow();
    });

    it("subscribes and unsubscribes to topics", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: client.installationId,
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const inviteTopic = buildWelcomeTopic(client2.installationId);
      await notificationClient.subscribe({
        installationId: "unsubscribe-test",
        topics: [inviteTopic],
      });

      await notificationClient.unsubscribe({
        installationId: "unsubscribe-test",
        topics: [inviteTopic],
      });
    });

    it("notifies when a conversation is created", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: "invite-subscribe-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const inviteTopic = buildWelcomeTopic(client2.installationId);
      await notificationClient.subscribe({
        installationId: "invite-subscribe-test",
        topics: [inviteTopic],
      });
      await client.conversations.newDm(client2.accountAddress);
      await client.conversations.newGroup([client2.accountAddress]);

      // end stream after 2 seconds
      setTimeout(() => {
        void stream.callback(null, undefined);
      }, 2000);

      let count = 0;
      for await (const notification of stream) {
        if (notification === undefined) {
          break;
        }
        count++;
        expect(notification.idempotency_key).toBeString();
        expect(notification.message.content_topic).toEqual(inviteTopic);
        expect(notification.message.message).toBeString();
        expect(notification.subscription.is_silent).toBe(false);
        expect(notification.subscription.topic).toEqual(inviteTopic);
        expect(notification.installation.id).toEqual("invite-subscribe-test");
        expect(notification.installation.delivery_mechanism.kind).toEqual(
          "apns",
        );
        expect(notification.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification.message_context.message_type).toEqual("v3-welcome");
      }

      expect(count).toBe(2);

      await notificationClient.unsubscribe({
        installationId: "invite-subscribe-test",
        topics: [inviteTopic],
      });
    });

    it("notifies when all DM group messages are sent", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: "dm-message-subscribe-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const dm = await client.conversations.newDm(client2.accountAddress);

      await client2.conversations.sync();
      const dm2 = await client2.conversations.getConversationById(dm.id);

      expect(dm2).toBeDefined();

      const conversationTopic = buildConversationTopic(dm.id);
      await notificationClient.subscribe({
        installationId: "dm-message-subscribe-test",
        topics: [conversationTopic],
      });

      await dm.send("gm");
      await dm2?.send("gm2");

      // end stream after 2 seconds
      setTimeout(() => {
        void stream.callback(null, undefined);
      }, 2000);

      let count = 0;
      for await (const notification of stream) {
        if (notification === undefined) {
          break;
        }
        count++;
        expect(notification.idempotency_key).toBeString();
        expect(notification.message.content_topic).toEqual(conversationTopic);
        expect(notification.message.message).toBeString();
        expect(notification.subscription.is_silent).toBe(false);
        expect(notification.subscription.topic).toEqual(conversationTopic);
        expect(notification.installation.id).toEqual(
          "dm-message-subscribe-test",
        );
        expect(notification.installation.delivery_mechanism.kind).toEqual(
          "apns",
        );
        expect(notification.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification.message_context.message_type).toEqual(
          "v3-conversation",
        );
        expect(notification.message_context.should_push).toEqual(true);
      }

      expect(count).toBe(2);

      await notificationClient.unsubscribe({
        installationId: "dm-message-subscribe-test",
        topics: [conversationTopic],
      });
    });

    it("notifies when all group messages are sent", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const client3 = await createClient();
      const client4 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: "group-message-subscribe-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const group = await client.conversations.newGroup([
        client2.accountAddress,
        client3.accountAddress,
        client4.accountAddress,
      ]);
      await client2.conversations.sync();
      await client3.conversations.sync();
      await client4.conversations.sync();

      const group2 = await client2.conversations.getConversationById(group.id);
      expect(group2).toBeDefined();

      const group3 = await client3.conversations.getConversationById(group.id);
      expect(group3).toBeDefined();

      const group4 = await client4.conversations.getConversationById(group.id);
      expect(group4).toBeDefined();

      const conversationTopic = buildConversationTopic(group.id);
      await notificationClient.subscribe({
        installationId: "group-message-subscribe-test",
        topics: [conversationTopic],
      });

      await group.send("gm");
      await group2?.send("gm2");
      await group3?.send("gm3");
      await group4?.send("gm4");

      // end stream after 2 seconds
      setTimeout(() => {
        void stream.callback(null, undefined);
      }, 2000);

      let count = 0;
      for await (const notification of stream) {
        if (notification === undefined) {
          break;
        }
        count++;
        expect(notification.idempotency_key).toBeString();
        expect(notification.message.content_topic).toEqual(conversationTopic);
        expect(notification.message.message).toBeString();
        expect(notification.subscription.is_silent).toBe(false);
        expect(notification.subscription.topic).toEqual(conversationTopic);
        expect(notification.installation.id).toEqual(
          "group-message-subscribe-test",
        );
        expect(notification.installation.delivery_mechanism.kind).toEqual(
          "apns",
        );
        expect(notification.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification.message_context.message_type).toEqual(
          "v3-conversation",
        );
        expect(notification.message_context.should_push).toEqual(true);
      }

      expect(count).toBe(4);

      await notificationClient.unsubscribe({
        installationId: "group-message-subscribe-test",
        topics: [conversationTopic],
      });
    });

    it("filters a specific user's sent messages in a DM", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: "hmac-dm-subscribe-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const dm = await client.conversations.newDm(client2.accountAddress);

      await client2.conversations.sync();
      const dm2 = await client2.conversations.getConversationById(dm.id);
      expect(dm2).toBeDefined();

      const hmacKeys = client2.conversations.hmacKeys();
      const conversationHmacKeys = hmacKeys[dm.id];
      expect(conversationHmacKeys).toBeDefined();

      const conversationTopic = buildConversationTopic(dm.id);
      const subscriptionHmacKeys = conversationHmacKeys.map((hmacKey) => ({
        thirtyDayPeriodsSinceEpoch: Number(hmacKey.epoch),
        key: Uint8Array.from(hmacKey.key),
      }));
      await notificationClient.subscribeWithMetadata({
        installationId: "hmac-dm-subscribe-test",
        subscriptions: [
          {
            topic: conversationTopic,
            isSilent: true,
            hmacKeys: subscriptionHmacKeys,
          },
        ],
      });

      await dm.send("gm");
      await dm2?.send("gm");

      // end stream after 2 seconds
      setTimeout(() => {
        void stream.callback(null, undefined);
      }, 2000);

      let count = 0;
      for await (const notification of stream) {
        if (notification === undefined) {
          break;
        }
        count++;
        expect(notification.idempotency_key).toBeString();
        expect(notification.message.content_topic).toEqual(conversationTopic);
        expect(notification.message.message).toBeString();
        expect(notification.subscription.is_silent).toBeTrue();
        expect(notification.subscription.topic).toEqual(conversationTopic);
        expect(notification.installation.id).toEqual("hmac-dm-subscribe-test");
        expect(notification.installation.delivery_mechanism.kind).toEqual(
          "apns",
        );
        expect(notification.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification.message_context.message_type).toEqual(
          "v3-conversation",
        );
        expect(notification.message_context.should_push).toEqual(true);
      }

      expect(count).toBe(1);

      await notificationClient.unsubscribe({
        installationId: "hmac-dm-subscribe-test",
        topics: [conversationTopic],
      });
    });

    it("filters a specific user's sent messages in a group", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const client3 = await createClient();
      const client4 = await createClient();
      const notificationClient = createNotificationClient();

      await notificationClient.registerInstallation({
        installationId: "hmac-group-subscribe-test",
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });

      const group = await client.conversations.newGroup([
        client2.accountAddress,
        client3.accountAddress,
        client4.accountAddress,
      ]);

      await client2.conversations.sync();
      await client3.conversations.sync();
      await client4.conversations.sync();

      const group2 = await client2.conversations.getConversationById(group.id);
      expect(group2).toBeDefined();

      const group3 = await client3.conversations.getConversationById(group.id);
      expect(group3).toBeDefined();

      const group4 = await client4.conversations.getConversationById(group.id);
      expect(group4).toBeDefined();

      const hmacKeys = client3.conversations.hmacKeys();
      const conversationHmacKeys = hmacKeys[group.id];
      expect(conversationHmacKeys).toBeDefined();

      const conversationTopic = buildConversationTopic(group.id);
      const subscriptionHmacKeys = conversationHmacKeys.map((hmacKey) => ({
        thirtyDayPeriodsSinceEpoch: Number(hmacKey.epoch),
        key: Uint8Array.from(hmacKey.key),
      }));
      await notificationClient.subscribeWithMetadata({
        installationId: "hmac-group-subscribe-test",
        subscriptions: [
          {
            topic: conversationTopic,
            isSilent: true,
            hmacKeys: subscriptionHmacKeys,
          },
        ],
      });

      await group.send("gm");
      await group2?.send("gm");
      await group3?.send("gm");
      await group4?.send("gm");

      // end stream after 2 seconds
      setTimeout(() => {
        void stream.callback(null, undefined);
      }, 2000);

      let count = 0;
      for await (const notification of stream) {
        if (notification === undefined) {
          break;
        }
        count++;
        expect(notification.idempotency_key).toBeString();
        expect(notification.message.content_topic).toEqual(conversationTopic);
        expect(notification.message.message).toBeString();
        expect(notification.subscription.is_silent).toBeTrue();
        expect(notification.subscription.topic).toEqual(conversationTopic);
        expect(notification.installation.id).toEqual(
          "hmac-group-subscribe-test",
        );
        expect(notification.installation.delivery_mechanism.kind).toEqual(
          "apns",
        );
        expect(notification.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification.message_context.message_type).toEqual(
          "v3-conversation",
        );
        expect(notification.message_context.should_push).toEqual(true);
      }

      expect(count).toBe(3);

      await notificationClient.unsubscribe({
        installationId: "hmac-group-subscribe-test",
        topics: [conversationTopic],
      });
    });
  });
});
