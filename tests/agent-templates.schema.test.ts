import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { describe, expect, test } from "bun:test";
import { prisma } from "@/utils/prisma";

const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);

const getSchemaBlock = (kind: "enum" | "model", name: string) => {
  const match = schema.match(
    new RegExp(`${kind}\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`),
  );

  return match?.[1] ?? "";
};

describe("AgentTemplate schema", () => {
  test("declares PublishStatus enum and Account.agentTemplates relation", () => {
    const publishStatusBlock = getSchemaBlock("enum", "PublishStatus");
    const publishStatusValues = publishStatusBlock.split(/\s+/).filter(Boolean);

    expect(publishStatusValues).toEqual([
      "draft",
      "published",
      "unlisted",
      "archived",
    ]);

    const accountBlock = getSchemaBlock("model", "Account");
    expect(accountBlock).toMatch(/\bagentTemplates\s+AgentTemplate\[\]/);
  });

  test("declares AgentTemplate fields, relations, and all six required indexes", () => {
    const agentTemplateBlock = getSchemaBlock("model", "AgentTemplate");

    const requiredFields = [
      /\bid\s+String\s+@id\s+@default\(dbgenerated\("gen_random_uuid\(\)"\)\)\s+@db\.Uuid\b/,
      /\bslug\s+String\b/,
      /\bownerAccountId\s+String\s+@db\.Uuid\b/,
      /\bforkedFromId\s+String\?\s+@db\.Uuid/,
      /\bagentName\s+String\b/,
      /\bdescription\s+String\?/,
      /\bprompt\s+String\s+@db\.Text\b/,
      /\bcategory\s+String\?/,
      /\bemoji\s+String\?/,
      /\bavatarUrl\s+String\?/,
      /\btools\s+String\[\]\s+@default\(\[\]\)/,
      /\bconnections\s+String\[\]\s+@default\(\[\]\)/,
      /\bversion\s+Int\s+@default\(1\)/,
      /\bfirstPublishedAt\s+DateTime\?/,
      /\bstatus\s+PublishStatus\s+@default\(draft\)/,
      /\bfeatured\s+Boolean\s+@default\(false\)/,
      /\bcreatedAt\s+DateTime\s+@default\(now\(\)\)/,
      /\bupdatedAt\s+DateTime\s+@updatedAt\b/,
    ];

    for (const fieldPattern of requiredFields) {
      expect(agentTemplateBlock).toMatch(fieldPattern);
    }

    expect(agentTemplateBlock).toMatch(
      /\bowner\s+Account\s+@relation\(fields: \[ownerAccountId\], references: \[id\]\)/,
    );

    const forkedFromRelation = agentTemplateBlock.match(
      /\bforkedFrom\s+AgentTemplate\?\s+@relation\("Forks", fields: \[forkedFromId\], references: \[id\][^)]*\)/,
    );
    expect(forkedFromRelation?.[0].replace(/\s+/g, " ")).toBe(
      'forkedFrom AgentTemplate? @relation("Forks", fields: [forkedFromId], references: [id])',
    );
    expect(agentTemplateBlock).toMatch(
      /\bforks\s+AgentTemplate\[\]\s+@relation\("Forks"\)/,
    );

    const requiredIndexes = [
      "@@unique([ownerAccountId, slug])",
      "@@index([slug])",
      "@@index([status, createdAt, id])",
      "@@index([status, category, createdAt, id])",
      "@@index([status, featured, createdAt, id])",
      "@@index([forkedFromId])",
    ];

    for (const indexDeclaration of requiredIndexes) {
      expect(agentTemplateBlock).toContain(indexDeclaration);
    }

    expect(agentTemplateBlock.match(/@@(?:unique|index)\(/g)).toHaveLength(6);
  });

  test("applies PublishStatus enum, foreign keys, and required indexes in Postgres", async () => {
    const enumValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'PublishStatus'
      ORDER BY e.enumsortorder
    `;

    expect(enumValues.map((row) => row.enumlabel)).toEqual([
      "draft",
      "published",
      "unlisted",
      "archived",
    ]);

    const foreignKeys = await prisma.$queryRaw<
      Array<{
        constraint_name: string;
        delete_rule: string;
        foreign_column: string;
        foreign_table: string;
        source_column: string;
        update_rule: string;
      }>
    >`
      SELECT
        tc.constraint_name,
        kcu.column_name AS source_column,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'AgentTemplate'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY kcu.column_name
    `;

    const ownerForeignKey = foreignKeys.find(
      (foreignKey) => foreignKey.source_column === "ownerAccountId",
    );
    const forkedFromForeignKey = foreignKeys.find(
      (foreignKey) => foreignKey.source_column === "forkedFromId",
    );

    expect(ownerForeignKey?.foreign_column).toBe("id");
    expect(ownerForeignKey?.foreign_table).toBe("Account");
    expect(forkedFromForeignKey?.delete_rule).toBe("SET NULL");
    expect(forkedFromForeignKey?.foreign_column).toBe("id");
    expect(forkedFromForeignKey?.foreign_table).toBe("AgentTemplate");

    const indexes = await prisma.$queryRaw<
      Array<{ indexdef: string; indexname: string }>
    >`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'AgentTemplate'
        AND indexname <> 'AgentTemplate_pkey'
      ORDER BY indexname
    `;

    expect(indexes.map((index) => index.indexname).sort()).toEqual([
      "AgentTemplate_forkedFromId_idx",
      "AgentTemplate_ownerAccountId_slug_key",
      "AgentTemplate_slug_idx",
      "AgentTemplate_status_category_createdAt_id_idx",
      "AgentTemplate_status_createdAt_id_idx",
      "AgentTemplate_status_featured_createdAt_id_idx",
    ]);

    const indexDefinitions = indexes.map((index) =>
      index.indexdef.replace(/\s+/g, " "),
    );

    expect(
      indexDefinitions.some(
        (indexDefinition) =>
          indexDefinition.includes(
            'UNIQUE INDEX "AgentTemplate_ownerAccountId_slug_key"',
          ) && indexDefinition.includes('("ownerAccountId", slug)'),
      ),
    ).toBe(true);
    expect(
      indexDefinitions.some((indexDefinition) =>
        indexDefinition.includes("(slug)"),
      ),
    ).toBe(true);
    expect(
      indexDefinitions.some((indexDefinition) =>
        indexDefinition.includes('(status, "createdAt", id)'),
      ),
    ).toBe(true);
    expect(
      indexDefinitions.some((indexDefinition) =>
        indexDefinition.includes('(status, category, "createdAt", id)'),
      ),
    ).toBe(true);
    expect(
      indexDefinitions.some((indexDefinition) =>
        indexDefinition.includes('(status, featured, "createdAt", id)'),
      ),
    ).toBe(true);
    expect(
      indexDefinitions.some((indexDefinition) =>
        indexDefinition.includes('("forkedFromId")'),
      ),
    ).toBe(true);
  });

  test("rejects AgentTemplate rows whose ownerAccountId does not exist", async () => {
    let caughtError: unknown;

    try {
      await prisma.agentTemplate.create({
        data: {
          id: "00000000-0000-4000-8000-000000000099",
          slug: "fk-violation",
          ownerAccountId: "00000000-0000-0000-0000-000000000000",
          agentName: "FK Violation",
          prompt: "This insert should fail before it is persisted.",
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caughtError as Prisma.PrismaClientKnownRequestError).code).toBe(
      "P2003",
    );
  });
});
