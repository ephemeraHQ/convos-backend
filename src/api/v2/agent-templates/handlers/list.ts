import type { AgentTemplate, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { serializeAgentTemplate } from "../lib/serialize-agent-template";
import { visibilityWhere } from "../lib/visibility";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Upper bound on the free-text search term — far longer than any real name or
// description query, but caps the LIKE pattern so a client can't push a
// multi-megabyte string into the query / logs.
const MAX_SEARCH_LENGTH = 200;

const VALID_STATUS_FILTERS = [
  "draft",
  "published",
  "unlisted",
  "archived",
] as const;

// Columns the list can be sorted by. `createdAt` desc is the default and
// preserves prior behavior. Each is keyset-paginatable: the cursor encodes
// the active column's value plus `id` as the tiebreaker.
const SORT_FIELDS = ["createdAt", "updatedAt", "agentName"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const querySchema = z
  .object({
    category: z.string().optional(),
    cursor: z.string().optional(),
    featured: z.string().optional(),
    limit: z.string().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    owner: z.string().optional(),
    q: z.string().max(MAX_SEARCH_LENGTH).optional(),
    sort: z.enum(SORT_FIELDS).optional(),
    status: z.string().optional(),
  })
  .passthrough();

const cursorPayloadSchema = z
  .object({
    id: z.string().min(1),
    // `s` = the sort field the cursor was built for; `o` = the order; `v` =
    // the sort field's value on the last row (ISO string for dates, the raw
    // string for agentName). Both `s` and `o` are validated against the
    // active request so a cursor can't traverse from the wrong end.
    o: z.enum(["asc", "desc"]),
    s: z.enum(SORT_FIELDS),
    v: z.string().min(1),
  })
  .strict();

const sendInvalidQuery = (res: Response, message: string) => {
  res.status(400).json({
    error: "Invalid request query",
    message,
  });
};

// Conjoin a filter onto `where.AND`, creating the array if needed. Status,
// search, and cursor filters all narrow the same query, so they accumulate
// here rather than each reaching for `where.AND` independently (which would
// silently clobber whatever a sibling already set).
const addAnd = (
  where: Prisma.AgentTemplateWhereInput,
  filter: Prisma.AgentTemplateWhereInput,
) => {
  where.AND = where.AND
    ? [...(where.AND as Prisma.AgentTemplateWhereInput[]), filter]
    : [filter];
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

const cursorValue = (template: AgentTemplate, sort: SortField): string =>
  sort === "agentName" ? template.agentName : template[sort].toISOString();

const encodeCursor = (
  template: AgentTemplate,
  sort: SortField,
  order: "asc" | "desc",
) =>
  Buffer.from(
    JSON.stringify({
      id: template.id,
      o: order,
      s: sort,
      v: cursorValue(template, sort),
    }),
  ).toString("base64url");

// Returns null when absent, undefined when malformed OR built for a different
// sort/order than the active one. A cursor encodes the comparator it was built
// for (sort column + direction); reusing it under a different sort or order
// would traverse from the wrong end of the dataset and skip/duplicate rows, so
// a mismatch forces the client to restart from the first page.
const decodeCursor = (
  cursor: string | undefined,
  sort: SortField,
  order: "asc" | "desc",
) => {
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

    if (!parsed.success || parsed.data.s !== sort || parsed.data.o !== order) {
      return undefined;
    }

    // Date columns must round-trip to a valid Date.
    if (
      sort !== "agentName" &&
      Number.isNaN(new Date(parsed.data.v).getTime())
    ) {
      return undefined;
    }

    return { id: parsed.data.id, value: parsed.data.v };
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

  const sort: SortField = parsed.data.sort ?? "createdAt";
  const order: "asc" | "desc" = parsed.data.order ?? "desc";

  const cursor = decodeCursor(parsed.data.cursor, sort, order);
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
      addAnd(where, { status: statusFilter as Prisma.EnumPublishStatusFilter });
      addAnd(where, { ownerAccountId: accountId });
    }
  } else {
    // No status filter: the caller's full visible set (admin → everything,
    // anonymous → published, user → published + own). Shared with the counts
    // handler via visibilityWhere so the two never drift.
    Object.assign(where, visibilityWhere(accountId, isApiKeyListener));
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

  // Free-text search: case-insensitive match on agentName OR description.
  // ANDed with the visibility/filter clauses so it narrows the visible set.
  const q = parsed.data.q?.trim();
  if (q) {
    const qFilter: Prisma.AgentTemplateWhereInput = {
      OR: [
        { agentName: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ],
    };
    addAnd(where, qFilter);
  }

  // Keyset cursor pagination, generalized over the active sort column.
  if (cursor) {
    const dir = order === "asc" ? "gt" : "lt";
    const value: string | Date =
      sort === "agentName" ? cursor.value : new Date(cursor.value);
    const cursorFilter: Prisma.AgentTemplateWhereInput = {
      OR: [
        { [sort]: { [dir]: value } },
        {
          [sort]: value,
          id: { [dir]: cursor.id },
        },
      ],
    };

    addAnd(where, cursorFilter);
  }

  const orderBy: Prisma.AgentTemplateOrderByWithRelationInput[] = [
    { [sort]: order },
    { id: order },
  ];

  try {
    const templates = await prisma.agentTemplate.findMany({
      where,
      orderBy,
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
          ? encodeCursor(lastTemplate, sort, order)
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
