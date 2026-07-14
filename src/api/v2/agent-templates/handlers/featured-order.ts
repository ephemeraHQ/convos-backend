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
    const gallery = await prisma.agentTemplate.findMany({
      where: { featured: true, status: "published" },
      select: { id: true },
    });

    const galleryIds = new Set(gallery.map((template) => template.id));
    const matchesGallery =
      galleryIds.size === unique.size &&
      templateIds.every((id) => galleryIds.has(id));
    if (!matchesGallery) {
      sendError(res, 409, {
        code: "GALLERY_CHANGED",
        message:
          "templateIds must be exactly the featured, published templates — the gallery changed, so re-read it and try again",
      });
      return;
    }

    // Heaviest leads, so the first id gets the largest weight. One transaction:
    // the gallery is never half-ordered, not even for a moment.
    const total = templateIds.length;
    await prisma.$transaction(
      templateIds.map((id, index) =>
        prisma.agentTemplate.update({
          where: { id },
          data: { featuredRank: total - index },
        }),
      ),
    );

    res.status(200).json({ updated: total });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to set featured gallery order",
    );
    res.status(500).json({ error: "Failed to set featured gallery order" });
  }
}
