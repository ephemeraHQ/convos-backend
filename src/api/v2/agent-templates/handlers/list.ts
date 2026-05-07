import type { AgentTemplate, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const querySchema = z
  .object({
    category: z.string().optional(),
    cursor: z.string().optional(),
    featured: z.string().optional(),
    limit: z.string().optional(),
    owner: z.string().optional(),
  })
  .passthrough();

const cursorPayloadSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

const serializeAgentTemplate = (template: AgentTemplate) => ({
  object: "agent_template",
  id: template.id,
  slug: template.slug,
  ownerAccountId: template.ownerAccountId,
  forkedFromId: template.forkedFromId,
  agentName: template.agentName,
  description: template.description,
  prompt: template.prompt,
  category: template.category,
  emoji: template.emoji,
  avatarUrl: template.avatarUrl,
  tools: template.tools,
  connections: template.connections,
  version: template.version,
  firstPublishedAt: template.firstPublishedAt?.toISOString() ?? null,
  status: template.status,
  featured: template.featured,
  createdAt: template.createdAt.toISOString(),
});

const sendInvalidQuery = (res: Response, message: string) => {
  res.status(400).json({
    error: "Invalid request query",
    message,
  });
};

const parseLimit = (value: string | undefined) => {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(parsed, MAX_LIMIT);
};

const encodeCursor = (template: AgentTemplate) =>
  Buffer.from(
    JSON.stringify({
      id: template.id,
      createdAt: template.createdAt.toISOString(),
    }),
  ).toString("base64url");

const decodeCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return null;
  }

  if (cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return undefined;
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    );
    const parsed = cursorPayloadSchema.safeParse(decoded);

    if (!parsed.success) {
      return undefined;
    }

    const createdAt = new Date(parsed.data.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return undefined;
    }

    return {
      id: parsed.data.id,
      createdAt,
    };
  } catch {
    return undefined;
  }
};

export async function listHandler(req: Request, res: Response) {
  if (Object.prototype.hasOwnProperty.call(req.query, "status")) {
    sendInvalidQuery(res, "status filter is not supported");
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    sendInvalidQuery(res, parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }

  const limit = parseLimit(parsed.data.limit);
  if (limit === null) {
    sendInvalidQuery(res, "limit must be a positive integer");
    return;
  }

  const cursor = decodeCursor(parsed.data.cursor);
  if (cursor === undefined) {
    sendInvalidQuery(res, "cursor is malformed");
    return;
  }

  const where: Prisma.AgentTemplateWhereInput = {
    status: "published",
  };

  if (parsed.data.category !== undefined) {
    where.category = parsed.data.category;
  }

  if (parsed.data.owner !== undefined) {
    where.ownerAccountId = parsed.data.owner;
  }

  if (parsed.data.featured === "true") {
    where.featured = true;
  }

  if (cursor !== null) {
    where.AND = [
      {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            id: { lt: cursor.id },
          },
        ],
      },
    ];
  }

  try {
    const templates = await prisma.agentTemplate.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const page = templates.slice(0, limit);
    const hasMore = templates.length > limit;
    const lastTemplate = page.at(-1);

    res.status(200).json({
      data: page.map(serializeAgentTemplate),
      hasMore,
      nextCursor:
        hasMore && lastTemplate !== undefined
          ? encodeCursor(lastTemplate)
          : null,
    });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to list agent templates",
    );
    res.status(500).json({ error: "Failed to list agent templates" });
  }
}
