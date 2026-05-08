import { describe, expect, test } from "bun:test";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";

type AccountColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  datetime_precision: number | null;
  column_default: string | null;
};

describe("Account migration", () => {
  test("Account table has UUID id column with gen_random_uuid default", async () => {
    const columns = await prisma.$queryRaw<AccountColumn[]>`
      SELECT column_name, data_type, is_nullable, datetime_precision, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Account'
      ORDER BY ordinal_position
    `;

    const idCol = columns.find((c) => c.column_name === "id");
    expect(idCol).toBeDefined();
    expect(idCol?.data_type).toBe("uuid");
    expect(idCol?.is_nullable).toBe("NO");
    expect(idCol?.column_default).toContain("gen_random_uuid()");
  });

  test("seeds admin account with deterministic UUID", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; createdAt: Date; updatedAt: Date }>
    >`
      SELECT id, "createdAt", "updatedAt"
      FROM "Account"
      WHERE id::text = ${ADMIN_ACCOUNT_ID}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ADMIN_ACCOUNT_ID);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
