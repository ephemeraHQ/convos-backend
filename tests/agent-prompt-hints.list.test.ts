import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { agentPromptHintsRouter } from "@/api/v2/agent-prompt-hints/agent-prompt-hints.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

type HintsEnvelope = { hints: unknown };

// All fixture rows carry this prefix so cleanup only ever touches test data and
// never the curated seed rows that live in the shared local database.
const TEST_PREFIX = "__hint_test__";

const buildApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/agent-prompt-hints", agentPromptHintsRouter);
  app.use(noRouteMiddleware);
  return app;
};

const app = buildApp();
let server: Server;
const baseURL = "http://localhost:4073";

const cleanup = () =>
  prisma.agentPromptHint.deleteMany({
    where: { text: { startsWith: TEST_PREFIX } },
  });

const createHint = (args: {
  text: string;
  published?: boolean;
  sortOrder?: number;
}) =>
  prisma.agentPromptHint.create({
    data: {
      text: args.text,
      published: args.published ?? true,
      sortOrder: args.sortOrder ?? 0,
    },
  });

// A fixed-length string (incl. the test prefix) so length-boundary assertions
// are exact under Postgres char_length semantics.
const textOfLength = (length: number, label: string) => {
  const head = `${TEST_PREFIX}${label}:`;
  return head + "x".repeat(Math.max(0, length - head.length));
};

const readHints = async (headers?: Record<string, string>) => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints`, {
    headers,
  });
  const body = (await response.json()) as HintsEnvelope;
  return { body, response };
};

// Only the fixture-owned strings, preserving the endpoint's returned order.
const testHints = (body: HintsEnvelope): string[] =>
  (body.hints as string[]).filter((hint) => hint.startsWith(TEST_PREFIX));

describe("Agent prompt hints list endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4073, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await cleanup();
  });

  test("returns published hints as a string array under hints with no auth", async () => {
    const text = `${TEST_PREFIX}alpha`;
    await createHint({ text, sortOrder: 1 });

    const { body, response } = await readHints();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Shape: a single `hints` key holding a flat array of strings.
    expect(Object.keys(body)).toEqual(["hints"]);
    expect(Array.isArray(body.hints)).toBe(true);
    expect((body.hints as unknown[]).every((h) => typeof h === "string")).toBe(
      true,
    );
    expect(body.hints as string[]).toContain(text);
  });

  test("excludes unpublished hints", async () => {
    const published = `${TEST_PREFIX}published`;
    const unpublished = `${TEST_PREFIX}unpublished`;
    await createHint({ text: published, published: true, sortOrder: 1 });
    await createHint({ text: unpublished, published: false, sortOrder: 2 });

    const { body } = await readHints();
    const hints = body.hints as string[];

    expect(hints).toContain(published);
    expect(hints).not.toContain(unpublished);
  });

  test("excludes hints longer than 350 characters, includes 350 exactly", async () => {
    const atLimit = textOfLength(350, "limit");
    const overLimit = textOfLength(351, "over");
    expect(atLimit.length).toBe(350);
    expect(overLimit.length).toBe(351);

    await createHint({ text: atLimit, sortOrder: 1 });
    await createHint({ text: overLimit, sortOrder: 2 });

    const { body } = await readHints();
    const hints = body.hints as string[];

    expect(hints).toContain(atLimit);
    expect(hints).not.toContain(overLimit);
  });

  test("orders published hints by sortOrder then id", async () => {
    const first = `${TEST_PREFIX}first`;
    const second = `${TEST_PREFIX}second`;
    const third = `${TEST_PREFIX}third`;
    // Insert out of order; the endpoint must return them by sortOrder asc.
    await createHint({ text: third, sortOrder: 30 });
    await createHint({ text: first, sortOrder: 10 });
    await createHint({ text: second, sortOrder: 20 });

    const { body } = await readHints();

    expect(testHints(body)).toEqual([first, second, third]);
  });
});
