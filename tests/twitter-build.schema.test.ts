import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

const ADMIN_ACCOUNT_ID = "48a05ef4-4a71-57a0-957f-a3d410992b31";

/**
 * Schema-level tests for the twitter-build feature.
 *
 * Validates:
 *   VAL-TB-SCHEMA-001 — CreateJobSource enum has exactly three values: app, web, twitter
 *   VAL-TB-SCHEMA-002 — CreateJob.source column defaults to "app"
 *   VAL-TB-SCHEMA-003 — CreateJob.metadata column is nullable JSON text
 *   VAL-TB-SCHEMA-004 — CreateJob.joinUrl is nullable
 *   VAL-TB-SCHEMA-005 — CreateJob.provisioningInstanceId, conversationId, inboxId are nullable
 *   VAL-TB-SCHEMA-006 — Migration adds source + metadata columns and adds nullable joinUrl/instance columns
 *   VAL-TB-SCHEMA-007 — Existing CreateJob rows default to source="app" after migration
 */
describe("Twitter-build schema changes", () => {
  // ── VAL-TB-SCHEMA-001: CreateJobSource enum exists with exactly three values ──

  test("declares CreateJobSource enum with exactly app, web, twitter", () => {
    const enumBlock = getSchemaBlock("enum", "CreateJobSource");
    const enumValues = enumBlock.split(/\s+/).filter(Boolean);

    expect(enumValues).toEqual(["app", "web", "twitter"]);
  });

  test("CreateJobSource enum is applied in Postgres with correct values", async () => {
    const enumValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'CreateJobSource'
      ORDER BY e.enumsortorder
    `;

    expect(enumValues.map((row) => row.enumlabel)).toEqual([
      "app",
      "web",
      "twitter",
    ]);
  });

  // ── VAL-TB-SCHEMA-002: CreateJob.source column defaults to "app" ──

  test("source column defaults to app in Prisma schema", () => {
    const createJobBlock = getSchemaBlock("model", "CreateJob");
    expect(createJobBlock).toMatch(
      /\bsource\s+CreateJobSource\s+@default\(value:\s*app\)/,
    );
  });

  test("source column defaults to app on insert", async () => {
    // CreateJob.id uses @default(uuid()) (client-side); use prisma client
    // so all schema-declared defaults — id and source — are exercised.
    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
      },
    });

    expect(job.source).toBe("app");

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  // ── VAL-TB-SCHEMA-003: CreateJob.metadata column is nullable JSON ──

  test("metadata column is nullable Json in Prisma schema", () => {
    const createJobBlock = getSchemaBlock("model", "CreateJob");
    expect(createJobBlock).toMatch(/\bmetadata\s+Json\?/);
  });

  test("metadata column accepts NULL in Postgres", async () => {
    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        // Prisma Json fields use Prisma.JsonNull for SQL NULL writes; the
        // imported `Prisma` namespace would shadow our own type alias, so use
        // the literal sentinel value instead.
        metadata: undefined,
      },
    });

    expect(job.metadata).toBeNull();

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  test("metadata column round-trips structured JSON values", async () => {
    const value = {
      idea: "Build a math tutor",
      twitterHandle: "@alice",
      tweetId: "1234567890",
    };

    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        metadata: value,
      },
    });

    // metadata comes back as a parsed JS object — no JSON.parse needed.
    const stored = job.metadata as typeof value;
    expect(stored.idea).toBe("Build a math tutor");
    expect(stored.twitterHandle).toBe("@alice");
    expect(stored.tweetId).toBe("1234567890");

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  // ── VAL-TB-SCHEMA-004: CreateJob.joinUrl is nullable ──

  test("joinUrl column is nullable in Prisma schema", () => {
    const createJobBlock = getSchemaBlock("model", "CreateJob");
    expect(createJobBlock).toMatch(/\bjoinUrl\s+String\?/);
  });

  test("joinUrl column accepts NULL for twitter source", async () => {
    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: "twitter",
        joinUrl: null,
      },
    });

    expect(job.joinUrl).toBeNull();

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  // ── VAL-TB-SCHEMA-005: CreateJob.provisioningInstanceId, conversationId, inboxId are nullable ──

  test("provisioningInstanceId, conversationId, inboxId are nullable in Prisma schema", () => {
    const createJobBlock = getSchemaBlock("model", "CreateJob");
    expect(createJobBlock).toMatch(/\bprovisioningInstanceId\s+String\?/);
    expect(createJobBlock).toMatch(/\bconversationId\s+String\?/);
    expect(createJobBlock).toMatch(/\binboxId\s+String\?/);
  });

  test("all three instance columns accept NULL for twitter source", async () => {
    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: "twitter",
        provisioningInstanceId: null,
        conversationId: null,
        inboxId: null,
      },
    });

    expect(job.provisioningInstanceId).toBeNull();
    expect(job.conversationId).toBeNull();
    expect(job.inboxId).toBeNull();

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  // ── VAL-TB-SCHEMA-006: Migration adds source + metadata columns and adds nullable joinUrl/instance columns ──

  test("migration adds all new columns with correct types and nullability", async () => {
    // Query column definitions from information_schema
    const columns = await prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'CreateJob'
        AND column_name IN ('source', 'metadata', 'joinUrl', 'provisioningInstanceId', 'conversationId', 'inboxId')
      ORDER BY column_name
    `;

    const colMap = new Map(columns.map((c) => [c.column_name, c]));

    // source: NOT NULL, enum type, default 'app'
    const source = colMap.get("source")!;
    expect(source.is_nullable).toBe("NO");
    expect(source.column_default).toContain("'app'");

    // metadata: nullable jsonb
    const metadata = colMap.get("metadata")!;
    expect(metadata.is_nullable).toBe("YES");
    expect(metadata.data_type).toBe("jsonb");

    // joinUrl: nullable text
    const joinUrl = colMap.get("joinUrl")!;
    expect(joinUrl.is_nullable).toBe("YES");
    expect(joinUrl.data_type).toBe("text");

    // provisioningInstanceId: nullable text
    const pgInst = colMap.get("provisioningInstanceId")!;
    expect(pgInst.is_nullable).toBe("YES");
    expect(pgInst.data_type).toBe("text");

    // conversationId: nullable text
    const convId = colMap.get("conversationId")!;
    expect(convId.is_nullable).toBe("YES");
    expect(convId.data_type).toBe("text");

    // inboxId: nullable text
    const inboxId = colMap.get("inboxId")!;
    expect(inboxId.is_nullable).toBe("YES");
    expect(inboxId.data_type).toBe("text");
  });

  // ── VAL-TB-SCHEMA-007: Existing CreateJob rows default to source="app" after migration ──

  test("existing rows default to source=app (backward compatible)", async () => {
    // Insert a row WITHOUT specifying source, simulating a pre-migration row.
    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
      },
    });

    expect(job.source).toBe("app");

    // Also verify no rows have source IS NULL — the column has a NOT NULL
    // constraint so any pre-existing row backfilled by the migration must
    // have a value.
    const nullRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "CreateJob" WHERE source IS NULL
    `;

    expect(Number(nullRows[0].count)).toBe(0);

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });

  // ── Additional: CreateJobSource CHECK constraint rejects invalid values ──

  test("source rejects invalid enum values", async () => {
    let caughtError: unknown;
    try {
      // Raw SQL is required — Prisma client's enum typing rejects invalid
      // values at the type level. Pass explicit id since @default(uuid())
      // is client-side only.
      await prisma.$executeRaw`
        INSERT INTO "CreateJob" ("id", "status", "input", "ownerAccountId", "source", "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, 'pending', '{}', ${ADMIN_ACCOUNT_ID}::uuid, 'INVALID_SOURCE', NOW(), NOW())
      `;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    const errorMsg =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
    expect(errorMsg.toLowerCase()).toMatch(/invalid|violation|check|enum/);
  });

  // ── Additional: All three source values are insertable ──

  test("all three source values (app, web, twitter) can be inserted", async () => {
    const sources = ["app", "web", "twitter"] as const;
    const insertedIds: string[] = [];

    for (const src of sources) {
      const job = await prisma.createJob.create({
        data: {
          input: "{}",
          ownerAccountId: ADMIN_ACCOUNT_ID,
          source: src,
        },
      });

      expect(job.source).toBe(src);
      insertedIds.push(job.id);
    }

    // Cleanup
    await prisma.createJob.deleteMany({ where: { id: { in: insertedIds } } });
  });

  // ── Full twitter-source row can be inserted with nullable fields ──

  test("twitter source row with all nullable fields set to NULL succeeds", async () => {
    const metadata = {
      idea: "Build a friendly math tutor",
      twitterHandle: "@alice",
      tweetId: "1234567890",
    };

    const job = await prisma.createJob.create({
      data: {
        input: "{}",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        source: "twitter",
        metadata,
        joinUrl: null,
        provisioningInstanceId: null,
        conversationId: null,
        inboxId: null,
      },
    });

    expect(job.source).toBe("twitter");
    expect(job.metadata).toEqual(metadata);
    expect(job.joinUrl).toBeNull();
    expect(job.provisioningInstanceId).toBeNull();
    expect(job.conversationId).toBeNull();
    expect(job.inboxId).toBeNull();

    // Cleanup
    await prisma.createJob.delete({ where: { id: job.id } });
  });
});
