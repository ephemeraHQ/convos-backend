import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { emptyStateMocksRouter } from "@/api/v2/empty-state-mocks/empty-state-mocks.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";

type MockConversation = {
  id: string;
  name: string;
  emoji: string;
  messageText: string;
};

type MockStuff = {
  id: string;
  title: string;
  emoji: string | null;
  html: string;
};

type Payload = {
  conversations: MockConversation[];
  stuffs: MockStuff[];
};

const buildApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/empty-state-mocks", emptyStateMocksRouter);
  app.use(noRouteMiddleware);
  return app;
};

let server: Server;
const baseURL = "http://localhost:4057";

beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(4057, () => {
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("GET /api/v2/empty-state-mocks", () => {
  test("returns the payload shape the iOS empty-state decoder expects", async () => {
    const response = await fetch(`${baseURL}/api/v2/empty-state-mocks`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as Payload;

    expect(body.conversations.length).toBeGreaterThan(0);
    for (const conversation of body.conversations) {
      expect(typeof conversation.id).toBe("string");
      expect(conversation.id.length).toBeGreaterThan(0);
      expect(typeof conversation.name).toBe("string");
      expect(conversation.name.length).toBeGreaterThan(0);
      expect(typeof conversation.emoji).toBe("string");
      expect(conversation.emoji.length).toBeGreaterThan(0);
      expect(typeof conversation.messageText).toBe("string");
      expect(conversation.messageText.length).toBeGreaterThan(0);
    }

    expect(body.stuffs.length).toBeGreaterThan(0);
    for (const stuff of body.stuffs) {
      expect(typeof stuff.id).toBe("string");
      expect(stuff.id.length).toBeGreaterThan(0);
      expect(typeof stuff.title).toBe("string");
      expect(stuff.title.length).toBeGreaterThan(0);
      // The app renders the inline HTML to a preview image; require a
      // complete document so the WKWebView snapshot has something real.
      expect(stuff.html).toContain("<!DOCTYPE html>");
      expect(stuff.html).toContain("</html>");
    }

    const conversationIds = body.conversations.map((c) => c.id);
    expect(new Set(conversationIds).size).toBe(conversationIds.length);
    const stuffIds = body.stuffs.map((s) => s.id);
    expect(new Set(stuffIds).size).toBe(stuffIds.length);
  });

  test("is publicly cacheable", async () => {
    const response = await fetch(`${baseURL}/api/v2/empty-state-mocks`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("requires no authentication", async () => {
    // No Authorization, X-Convos-AuthToken, or AppCheck headers at all.
    const response = await fetch(`${baseURL}/api/v2/empty-state-mocks`);
    expect(response.status).toBe(200);
  });
});
