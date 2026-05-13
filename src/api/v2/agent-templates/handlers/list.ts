import type { AgentTemplate, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { serializeAgentTemplate } from "../lib/serialize-agent-template";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const VALID_STATUS_FILTERS = [
  "draft",
  "published",
  "unlisted",
  "archived",
] as const;

const querySchema = z
  .object({
    category: z.string().optional(),
    cursor: z.string().optional(),
    featured: z.string().optional(),
    limit: z.string().optional(),
    owner: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const cursorPayloadSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

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
  // The router uses `optionalAuthOrAgentApiKeyAuth`, so `accountId` is set
  // when the caller presented valid credentials and `undefined` for
  // anonymous callers. Anonymous = published-only view.
  const accountId: string | undefined = res.locals.accountId;
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;

  // Status filter handling. Express + qs can deliver `?status=draft` as a
  // string OR `?status=draft&status=published` as an array of strings (and
  // bracket-notation `?status[foo]=bar` as a nested object). Narrow to a
  // single string explicitly so a repeated/object form is rejected with
  // the same 400 as an invalid enum value instead of slipping through a
  // silent cast.
  const hasStatusFilter = Object.prototype.hasOwnProperty.call(
    req.query,
    "status",
  );
  const rawStatus = req.query.status;
  const statusFilter = typeof rawStatus === "string" ? rawStatus : undefined;

  if (hasStatusFilter) {
    if (
      statusFilter === undefined ||
      !VALID_STATUS_FILTERS.includes(
        statusFilter as (typeof VALID_STATUS_FILTERS)[number],
      )
    ) {
      sendInvalidQuery(res, "Invalid status filter value");
      return;
    }
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

  // Build the where clause based on caller type (anonymous vs regular user
  // vs API key listener).
  const where: Prisma.AgentTemplateWhereInput = {};

  if (hasStatusFilter && statusFilter) {
    // API key listeners see all templates with that status (admin-like access);
    // regular users see only their own templates with the requested status;
    // anonymous callers can only ask for `published` — any other status
    // returns an empty result (no enumeration of drafts/unlisted/archived).
    if (isApiKeyListener) {
      where.status = statusFilter as Prisma.EnumPublishStatusFilter;
    } else if (accountId === undefined) {
      if (statusFilter !== "published") {
        res.status(200).json({ data: [], hasMore: false, nextCursor: null });
        return;
      }
      where.status = "published";
    } else {
      where.AND = [
        { status: statusFilter as Prisma.EnumPublishStatusFilter },
        { ownerAccountId: accountId },
      ];
    }
  } else if (isApiKeyListener) {
    // API key listener sees everything (admin-like access). No filter needed.
  } else if (accountId === undefined) {
    // Anonymous caller with no status filter: published-only view.
    where.status = "published";
  } else {
    // Regular authenticated user without status filter:
    // Published templates from any owner + own drafts/unlisted/archived.
    where.OR = [
      { status: "published" },
      {
        status: { in: ["draft", "unlisted", "archived"] },
        ownerAccountId: accountId,
      },
    ];
  }

  if (parsed.data.category !== undefined) {
    where.category = parsed.data.category;
  }

  // The `owner` filter must compose with the visibility OR clause.
  // If there's a visibility OR clause, we need to apply ownerAccountId
  // as an additional AND constraint within each OR branch.
  if (parsed.data.owner !== undefined) {
    // Non-UUID owner values can't match any row; short-circuit with an empty
    // result rather than handing Prisma a malformed UUID (which throws).
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(parsed.data.owner)) {
      res.status(200).json({ data: [], hasMore: false, nextCursor: null });
      return;
    }

    const ownerFilter = { ownerAccountId: parsed.data.owner };
    if (where.OR) {
      // Apply owner filter to each OR branch by converting to AND inside each
      where.OR = where.OR.map((branch) => ({
        AND: [branch, ownerFilter],
      }));
    } else {
      where.ownerAccountId = parsed.data.owner;
    }
  }

  if (parsed.data.featured === "true") {
    where.featured = true;
  }

  // Cursor pagination: compose with existing AND/OR clauses
  if (cursor !== null) {
    const cursorFilter = {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        {
          createdAt: cursor.createdAt,
          id: { lt: cursor.id },
        },
      ],
    };

    if (where.AND) {
      // Already have an AND clause from visibility rules — append cursor filter
      (where.AND as Prisma.AgentTemplateWhereInput[]).push(cursorFilter);
    } else {
      where.AND = [cursorFilter];
    }
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
      data: page.map((template) => serializeAgentTemplate(template)),
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
