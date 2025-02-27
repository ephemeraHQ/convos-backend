import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
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

  describe.only("subscriptions", () => {
    let app: express.Application;
    let server: Server;
    let stream: AsyncStream<NotificationResponse>;

    beforeEach(() => {
      app = express();
      app.use(jsonMiddleware);
      stream = new AsyncStream<NotificationResponse>();
      app.post("/", (req: Request, res: Response) => {
        console.log("received notification", req.body);
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

    test("conversation invites", async () => {
      const client = await createClient();
      const client2 = await createClient();
      const notificationClient = createNotificationClient();

      const registerResponse = await notificationClient.registerInstallation({
        installationId: client.installationId,
        deliveryMechanism: {
          deliveryMechanismType: {
            case: "apnsDeviceToken",
            value: "token",
          },
        },
      });
      expect(registerResponse.installationId).toBe(client.installationId);
      expect(registerResponse.validUntil).toBeGreaterThan(0);

      const inviteTopic = buildWelcomeTopic(client2.installationId);
      await notificationClient.subscribeWithMetadata({
        installationId: client.installationId,
        subscriptions: [
          {
            topic: inviteTopic,
            isSilent: true,
          },
        ],
      });
      await client.conversations.newDm(client2.accountAddress);

      console.log("created DM");

      for await (const notification of stream) {
        console.log(notification);
        expect(notification?.idempotency_key).toBeString();
        expect(notification?.message.content_topic).toEqual(inviteTopic);
        expect(notification?.message.message).toBeString();
        expect(notification?.subscription.is_silent).toBeTrue();
        expect(notification?.installation.delivery_mechanism.token).toEqual(
          "token",
        );
        expect(notification?.message_context.message_type).toEqual(
          "v3-welcome",
        );
        // end stream
        break;
      }
    });
  });
});
