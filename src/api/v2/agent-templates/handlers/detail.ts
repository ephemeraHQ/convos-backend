import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { resolveAgentTemplateByIdOrHashedSlug } from "../lib/resolve-id-or-hashed-slug";
import { serializeAgentTemplate } from "../lib/serialize-agent-template";

const paramsSchema = z
  .object({
    idOrHashedSlug: z.string().min(1),
  })
  .strict();

const expandValueSchema = z.union([z.string(), z.array(z.string())]);

const querySchema = z
  .object({
    expand: expandValueSchema.optional(),
    "expand[]": expandValueSchema.optional(),
  })
  .passthrough();

const toArray = (value: string | string[] | undefined) => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const parseExpandValues = (query: z.infer<typeof querySchema>) => [
  ...toArray(query.expand),
  ...toArray(query["expand[]"]),
];

export async function detailHandler(req: Request, res: Response) {
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(404).json({ error: "Agent template not found" });
    return;
  }

  const parsedQuery = querySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({
      error: "Invalid request query",
      details: parsedQuery.error.issues,
    });
    return;
  }

  try {
    const template = await resolveAgentTemplateByIdOrHashedSlug({
      idOrHashedSlug: parsedParams.data.idOrHashedSlug,
    });

    if (template === null) {
      res.status(404).json({ error: "Agent template not found" });
      return;
    }

    const expandValues = parseExpandValues(parsedQuery.data);
    const expandOwner = expandValues.includes("owner");
    const includeSkills =
      expandValues.includes("skills") || expandValues.includes("skills.files");

    const owner = expandOwner
      ? await prisma.account.findUnique({
          where: { id: template.ownerAccountId },
        })
      : undefined;

    if (owner === null) {
      req.log.error(
        { ownerAccountId: template.ownerAccountId, templateId: template.id },
        "Agent template owner account not found",
      );
      res.status(500).json({ error: "Failed to load template owner" });
      return;
    }

    res
      .status(200)
      .json(
        serializeAgentTemplate(
          template,
          owner === undefined ? { includeSkills } : { includeSkills, owner },
        ),
      );
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to get agent template detail",
    );
    res.status(500).json({ error: "Failed to get agent template" });
  }
}
