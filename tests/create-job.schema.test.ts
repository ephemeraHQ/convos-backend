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

/**
 * Schema-level tests for the CreateJob model.
 *
 * Validates:
 *   VAL-CJ-SCHEMA-001 — CreateJob model exists with all required columns
 *   VAL-CJ-SCHEMA-002 — CreateJobStatus enum has exactly five values
 *   VAL-CJ-SCHEMA-003 — FK from CreateJob.ownerAccountId to Account.id
 *   VAL-CJ-SCHEMA-004 — Account model has inverse relation createJobs
 *   VAL-CJ-SCHEMA-005 — Migration adds CreateJob table with correct SQL types
 *   VAL-CJ-SCHEMA-006 — CreateJob.id defaults to UUID on insert
 *   VAL-CJ-SCHEMA-007 — CreateJob.status defaults to "pending" on insert
 *   VAL-CJ-SCHEMA-008 — CreateJob.status CHECK constraint rejects invalid values
 *   VAL-CJ-SCHEMA-009 — CreateJob.result and CreateJob.error are nullable
 *   VAL-CJ-SCHEMA-010 — CreateJob.expiresAt is nullable
 */
describe("CreateJob schema", () => {
  // ── VAL-CJ-SCHEMA-001: CreateJob Prisma model exists with all required columns ──

  test("declares CreateJob fields, relation, and index", () => {
    const createJobBlock = getSchemaBlock("model", "CreateJob");

    const requiredFields = [
      /\bid\s+String\s+@id\s+@default\(dbgenerated\("gen_random_uuid\(\)::text"\)\)/,
      /\bstatus\s+CreateJobStatus\s+@default\(value:\s*pending\)/,
      /\binput\s+String\b/,
      /\bownerAccountId\s+String\s+@db\.Uuid\b/,
      /\bresult\s+String\?/,
      /\berror\s+String\?/,
      /\bcreatedAt\s+DateTime\s+@default\(now\(\)\)/,
      /\bupdatedAt\s+DateTime\s+@updatedAt\b/,
      /\bexpiresAt\s+DateTime\?/,
    ];

    for (const fieldPattern of requiredFields) {
      expect(createJobBlock).toMatch(fieldPattern);
    }

    // Relation to Account
    expect(createJobBlock).toMatch(
      /\bowner\s+Account\s+@relation\(fields: \[ownerAccountId\], references: \[id\]\)/,
    );

    // Index on [status, createdAt]
    expect(createJobBlock).toContain("@@index([status, createdAt])");
  });

  // ── VAL-CJ-SCHEMA-002: CreateJobStatus enum has exactly five values ──

  test("declares CreateJobStatus enum with exactly five values", () => {
    const enumBlock = getSchemaBlock("enum", "CreateJobStatus");
    const enumValues = enumBlock.split(/\s+/).filter(Boolean);

    expect(enumValues).toEqual([
      "pending",
      "generating",
      "provisioning",
      "done",
      "failed",
    ]);
  });

  // ── VAL-CJ-SCHEMA-004: Account model has inverse relation ──

  test("Account model has inverse relation createJobs", () => {
    const accountBlock = getSchemaBlock("model", "Account");
    expect(accountBlock).toMatch(/\bcreateJobs\s+CreateJob\[\]/);
  });

  // ── VAL-CJ-SCHEMA-003, 005: Postgres-level verification ──

  test("applies CreateJobStatus enum, foreign keys, and indexes in Postgres", async () => {
    // Verify enum values
    const enumValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'CreateJobStatus'
      ORDER BY e.enumsortorder
    `;

    expect(enumValues.map((row) => row.enumlabel)).toEqual([
      "pending",
      "generating",
      "provisioning",
      "done",
      "failed",
    ]);

    // Verify foreign keys
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
        AND tc.table_name = 'CreateJob'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY kcu.column_name
    `;

    const ownerForeignKey = foreignKeys.find(
      (fk) => fk.source_column === "ownerAccountId",
    );
    expect(ownerForeignKey?.foreign_column).toBe("id");
    expect(ownerForeignKey?.foreign_table).toBe("Account");

    // Verify indexes
    const indexes = await prisma.$queryRaw<
      Array<{ indexdef: string; indexname: string }>
    >`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'CreateJob'
        AND indexname <> 'CreateJob_pkey'
      ORDER BY indexname
    `;

    const indexNames = indexes.map((idx) => idx.indexname).sort();
    expect(indexNames).toEqual(["CreateJob_status_createdAt_idx"]);

    const indexDefinitions = indexes.map((idx) =>
      idx.indexdef.replace(/\s+/g, " "),
    );

    expect(
      indexDefinitions.some((def) => def.includes('(status, "createdAt")')),
    ).toBe(true);
  });

  // ── VAL-CJ-SCHEMA-006: CreateJob.id defaults to UUID on insert ──

  test("id defaults to UUID on insert", async () => {
    const adminAccountId = "48a05ef4-4a71-57a0-957f-a3d410992b31";

    const result = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "CreateJob" ("status", "input", "ownerAccountId", "createdAt", "updatedAt")
      VALUES ('pending', '{}', ${adminAccountId}::uuid, NOW(), NOW())
      RETURNING id
    `;

    expect(result).toHaveLength(1);
    const id = result[0].id;
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // Cleanup (id is TEXT, no ::uuid cast)
    await prisma.$executeRaw`DELETE FROM "CreateJob" WHERE id = ${id}`;
  });

  // ── VAL-CJ-SCHEMA-007: CreateJob.status defaults to "pending" on insert ──

  test("status defaults to pending on insert", async () => {
    const adminAccountId = "48a05ef4-4a71-57a0-957f-a3d410992b31";

    const result = await prisma.$queryRaw<
      Array<{ status: string; id: string }>
    >`
      INSERT INTO "CreateJob" ("input", "ownerAccountId", "createdAt", "updatedAt")
      VALUES ('{}', ${adminAccountId}::uuid, NOW(), NOW())
      RETURNING id, status
    `;

    expect(result[0].status).toBe("pending");

    // Cleanup
    await prisma.$executeRaw`DELETE FROM "CreateJob" WHERE id = ${result[0].id}`;
  });

  // ── VAL-CJ-SCHEMA-008: CreateJob.status CHECK constraint rejects invalid values ──

  test("status rejects invalid enum values", async () => {
    const adminAccountId = "48a05ef4-4a71-57a0-957f-a3d410992b31";

    let caughtError: unknown;
    try {
      await prisma.$executeRaw`
        INSERT INTO "CreateJob" ("status", "input", "ownerAccountId", "createdAt", "updatedAt")
        VALUES ('INVALID_STATUS', '{}', ${adminAccountId}::uuid, NOW(), NOW())
      `;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    // PostgreSQL raises a type violation for invalid enum values
    const errorMsg =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
    expect(errorMsg.toLowerCase()).toMatch(/invalid|violation|check|enum/);
  });

  // ── VAL-CJ-SCHEMA-009: CreateJob.result and CreateJob.error are nullable ──

  test("result and error accept NULL values", async () => {
    const adminAccountId = "48a05ef4-4a71-57a0-957f-a3d410992b31";

    const result = await prisma.$queryRaw<
      Array<{ id: string; result: string | null; error: string | null }>
    >`
      INSERT INTO "CreateJob" ("status", "input", "ownerAccountId", "result", "error", "createdAt", "updatedAt")
      VALUES ('pending', '{}', ${adminAccountId}::uuid, NULL, NULL, NOW(), NOW())
      RETURNING id, result, error
    `;

    expect(result[0].result).toBeNull();
    expect(result[0].error).toBeNull();

    // Cleanup
    await prisma.$executeRaw`DELETE FROM "CreateJob" WHERE id = ${result[0].id}`;
  });

  // ── VAL-CJ-SCHEMA-010: CreateJob.expiresAt is nullable ──

  test("expiresAt is nullable", async () => {
    const adminAccountId = "48a05ef4-4a71-57a0-957f-a3d410992b31";

    const result = await prisma.$queryRaw<
      Array<{ id: string; expiresAt: Date | null }>
    >`
      INSERT INTO "CreateJob" ("status", "input", "ownerAccountId", "createdAt", "updatedAt")
      VALUES ('pending', '{}', ${adminAccountId}::uuid, NOW(), NOW())
      RETURNING id, "expiresAt"
    `;

    expect(result[0].expiresAt).toBeNull();

    // Cleanup
    await prisma.$executeRaw`DELETE FROM "CreateJob" WHERE id = ${result[0].id}`;
  });

  // ── FK constraint: rejects ownerAccountId that does not exist ──

  test("rejects CreateJob rows whose ownerAccountId does not exist", async () => {
    let caughtError: unknown;

    try {
      await prisma.createJob.create({
        data: {
          input: "{}",
          ownerAccountId: "00000000-0000-0000-0000-000000000000",
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
