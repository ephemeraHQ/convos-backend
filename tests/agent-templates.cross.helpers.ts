import type { Server } from "node:http";
import express from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { buildSlug } from "@/utils/slug-hash";

export type TemplateBody = Record<string, unknown>;
export type ListBody = {
  data: TemplateBody[];
  hasMore: boolean;
  nextCursor: string | null;
};

export const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

export const startAgentTemplatesServer = async (port: number) => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/agent-templates", agentTemplatesRouter);
  app.use(noRouteMiddleware);

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
  }),
});

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
}) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates${args.query ?? ""}`,
  );
  const body = (await response.json()) as ListBody;

  return { body, response };
};

export const getTemplate = async (args: { baseURL: string; path: string }) => {
  const response = await fetch(
    `${args.baseURL}/api/v2/agent-templates/${args.path}`,
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

export const hashedSlugFor = (template: TemplateBody) =>
  buildSlug(template.slug as string, template.id as string);
