import { createHash } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildUrlSlug } from "@/utils/url-slug";

/**
 * Derive a deterministic UUIDv5-shaped string from a human-readable label
 * so test fixtures can keep using mnemonic keys ("idem-1", "tw-happy")
 * while still satisfying the handler's UUID validation. The same label
 * always produces the same UUID, so two calls to `withKey("idem-1")`
 * still dedupe correctly inside an idempotency test.
 *
 * Pure SHA-1 of `namespace:label`, sliced into the UUIDv5 layout and
 * pinned to version=5/variant=10xx. Not cryptographically meaningful;
 * this is purely a format-compliant identifier generator for tests.
 */
export const stableUuid = (label: string): string => {
  const hex = createHash("sha1")
    .update(`agent-templates-test:${label}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export type TemplateBody = Record<string, unknown>;
export type ListBody = {
  data: TemplateBody[];
  hasMore: boolean;
  nextCursor: string | null;
};

export const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

/**
 * Build the standard agent-templates Express app used across in-process
 * test files. Wires up the four middlewares + the `/api/v2/agent-templates`
 * router mount that every router-level test needs:
 *
 *   pinoMiddleware → jsonMiddleware → agentTemplatesRouter → noRouteMiddleware
 *
 * Caller is responsible for `app.listen()` (or driving via `request(app)`).
 * For an http-server-based setup, use `startAgentTemplatesServer` below.
 */
export const buildAgentTemplatesApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/agent-templates", agentTemplatesRouter);
  app.use(noRouteMiddleware);
  return app;
};

export const startAgentTemplatesServer = async (port: number) => {
  const app = buildAgentTemplatesApp();

  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(port, () => {
      resolve();
    });
  });

  return {
    baseURL: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

export const jwtHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-cross",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

// Non-owner reader used for list/detail by default. Read endpoints now
// require auth, but the visibility rules differ for owner vs non-owner:
// non-owners see only published templates from any account. Using a distinct
// reader keeps cross-flow tests' visibility assertions stable — drafts and
// archived templates remain invisible in the listing.
const READER_ACCOUNT_ID = "00000000-0000-4000-8000-cccccccc0001";

export const readerHeaders = async (): Promise<Record<string, string>> => {
  // Fail-closed auth: a JWT accountId claim must reference a live Account
  // row, so the synthetic reader account has to exist.
  await prisma.account.upsert({
    where: { id: READER_ACCOUNT_ID },
    update: {},
    create: { id: READER_ACCOUNT_ID },
  });
  return {
    "Content-Type": "application/json",
    "X-Convos-AuthToken": await createJwtToken({
      deviceId: "test-device-agent-templates-cross-reader",
      accountId: READER_ACCOUNT_ID,
    }),
  };
};

export const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

export const jsonHeaders = { "Content-Type": "application/json" };

export const createTemplate = async (args: {
  baseURL: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(`${args.baseURL}/api/v2/agent-templates`, {
    method: "POST",
    headers: args.headers ?? (await jwtHeaders()),
    body: JSON.stringify(args.body),
  });
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const publishTemplate = async (args: {
  baseURL: string;
  id: string;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates/${args.id}/publish`,
    {
      method: "POST",
      headers: args.headers ?? (await jwtHeaders()),
    },
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const patchTemplate = async (args: {
  baseURL: string;
  id: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates/${args.id}`,
    {
      method: "PATCH",
      headers: args.headers ?? (await jwtHeaders()),
      body: JSON.stringify(args.body),
    },
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const deleteTemplate = async (args: {
  baseURL: string;
  id: string;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates/${args.id}`,
    {
      method: "DELETE",
      headers: args.headers ?? (await jwtHeaders()),
    },
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const listTemplates = async (args: {
  baseURL: string;
  query?: string;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates${args.query ?? ""}`,
    { headers: args.headers ?? (await readerHeaders()) },
  );
  const body = (await response.json()) as ListBody;

  return { body, response };
};

export const getTemplate = async (args: {
  baseURL: string;
  path: string;
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates/${args.path}`,
    { headers: args.headers ?? (await readerHeaders()) },
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const urlSlugFor = (template: TemplateBody) =>
  buildUrlSlug(template.slug as string, template.id as string);
