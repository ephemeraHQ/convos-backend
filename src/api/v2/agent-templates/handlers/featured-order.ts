import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// The gallery holds far fewer than this; the cap just bounds the transaction.
const MAX_GALLERY = 200;

const bodySchema = z.object({
  // The whole gallery, top slot first.
  templateIds: z.array(z.string().uuid()).min(1).max(MAX_GALLERY),
});

const sendError = (
  res: Response,
  status: number,
  error: { code: string; message: string },
) => {
  res.status(status).json({ error });
};

/**
 * Did Postgres refuse this transaction because another one moved the gallery
 * under it?
 *
 * Two shapes, because the transaction mixes query styles: Prisma maps a
 * serialization failure in its OWN queries to `P2034`, while a raw query
 * surfaces the driver's code instead — `40001`, serialization_failure — wrapped
 * as `P2010`. Matching only the first lets a genuine, expected conflict escape
 * as a 500.
 */
export const isSerializationFailure = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code === "P2034") {
    return true;
  }
  const meta = error.meta as { code?: string } | undefined;
  return error.code === "P2010" && meta?.code === "40001";
};

/**
 * Write the featured gallery's order — the whole thing, in one transaction.
 *
 * A reorder used to be one PATCH per row, and convos.org renders those as they
 * land: a failure halfway through left the homepage on a blend of the old order
 * and the new one, which no amount of client-side undo can rule out (the undo
 * is itself a sequence of writes that can fail). The order is a single value,
 * so it moves once or not at all.
 *
 * The body must be the *entire* gallery. A partial list would leave the rows it
 * omits holding weights that collide with the ones it sets, which is how you
 * get two templates claiming one slot. If the gallery has changed since the
 * caller read it — something published, featured, or dropped out — the ids
 * won't match and the write is refused rather than clobbering a set the caller
 * never saw.
 */
export async function featuredOrderHandler(req: Request, res: Response) {
  // Curation is the dashboard's, not an owner's — same rule the rank field
  // itself carries in PATCH.
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;
  if (!isApiKeyListener) {
    req.log.warn(
      { callerAccountId: res.locals.accountId, action: "featured-order" },
      "Unauthorized agent-template curation attempt",
    );
    sendError(res, 403, {
      code: "FORBIDDEN",
      message: "Not authorized to set the featured gallery order",
    });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const { templateIds } = parsed.data;
  const unique = new Set(templateIds);
  if (unique.size !== templateIds.length) {
    sendError(res, 400, {
      code: "DUPLICATE_TEMPLATE",
      message: "templateIds contains the same template more than once",
    });
    return;
  }

  try {
    const total = templateIds.length;

    // The membership check and the writes are one transaction, at SERIALIZABLE.
    //
    // Both halves are needed. Reading the gallery outside the write would make
    // this a check-then-act across two round trips; and moving the read inside a
    // default (READ COMMITTED) transaction wouldn't close it either, since every
    // statement there takes a fresh snapshot — a template featured or dropped
    // between the check and the writes would still slip past. The damaging case
    // is a row LEAVING the gallery mid-write: it stays in `templateIds`, takes a
    // weight it's no longer entitled to, and — because a weight is a slot —
    // silently reclaims that slot when it comes back. Exactly the invariant the
    // patch handler enforces, walked around from the side.
    //
    // SERIALIZABLE makes the read and the writes see one snapshot and aborts the
    // loser of a conflicting pair, which surfaces below as the same 409 a stale
    // set gets: re-read the gallery and try again.
    const updated = await prisma.$transaction(
      async (tx) => {
        const gallery = await tx.agentTemplate.findMany({
          where: { featured: true, status: "published" },
          select: { id: true },
        });

        const galleryIds = new Set(gallery.map((template) => template.id));
        const matchesGallery =
          galleryIds.size === unique.size &&
          templateIds.every((id) => galleryIds.has(id));
        if (!matchesGallery) {
          return null;
        }

        // Heaviest leads, so the first id gets the largest weight. One statement
        // for the whole gallery, rather than an update per row: it keeps the
        // SERIALIZABLE window to a single round trip (fewer aborts under a
        // concurrent write), and it leaves `updatedAt` alone — Prisma's `update`
        // would touch it on every row, so a reorder would stamp the entire
        // gallery as freshly edited, and `updatedAt` is a sort the list API
        // offers. Ranking a template is not editing it.
        const written = await tx.$executeRaw`
          UPDATE "AgentTemplate" AS t
          SET "featuredRank" = v.rank
          FROM (VALUES ${Prisma.join(
            templateIds.map(
              (id, index) => Prisma.sql`(${id}::uuid, ${total - index}::int)`,
            ),
          )}) AS v(id, rank)
          WHERE t."id" = v.id
        `;
        // Membership was checked in this same snapshot, so every id must land.
        // If one didn't, the order we'd be storing isn't the one we validated.
        if (written !== total) {
          throw new Error(
            `featured-order wrote ${written} of ${total} templates`,
          );
        }
        return total;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (updated === null) {
      sendError(res, 409, {
        code: "GALLERY_CHANGED",
        message:
          "templateIds must be exactly the featured, published templates — the gallery changed, so re-read it and try again",
      });
      return;
    }

    res.status(200).json({ updated });
  } catch (error) {
    // A serialization failure means the gallery moved under this write. The
    // caller's answer is the same as for a set that was already stale.
    if (isSerializationFailure(error)) {
      sendError(res, 409, {
        code: "GALLERY_CHANGED",
        message:
          "the gallery changed while this order was being written — re-read it and try again",
      });
      return;
    }
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to set featured gallery order",
    );
    res.status(500).json({ error: "Failed to set featured gallery order" });
  }
}
