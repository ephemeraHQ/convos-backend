import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { prisma } from "@/utils/prisma";

/**
 * Schema guards for the deletion feature: the RESTRICT protections must keep
 * biting at the database layer, and every account-correlatable table must be
 * explicitly accounted for in the teardown inventory below — a new table
 * that could carry account data fails this test until it is added to the
 * teardown (or documented as retained).
 */

describe("deletion schema guards", () => {
  test("deleting an Account with children still fails at the DB layer", async () => {
    const account = await prisma.account.create({
      data: {
        authMethods: {
          create: { type: "SIWE", externalKey: `0x${"9".repeat(40)}` },
        },
      },
    });
    try {
      await expect(
        prisma.account.delete({ where: { id: account.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await prisma.authMethod.deleteMany({ where: { accountId: account.id } });
      await prisma.account.delete({ where: { id: account.id } });
    }
  });

  test("every account-correlatable model is in the teardown inventory", () => {
    // Deleted by the teardown transaction (or cascading from it).
    const deleted = new Set([
      "Account",
      "AuthMethod",
      "UserCredits",
      "CreditLedger",
      "Subscription",
      "BillingReceipt",
      "AgentTemplate",
      "AgentTemplateGeneration",
      "ConnectionGrant",
      "DeviceRegistration",
      "ClientIdentifier",
    ]);
    // Retained by design, pseudonymized or bounded-lifetime (see
    // docs/plans/delete-my-account.md retention regime).
    const retained = new Set([
      "AdminAudit", // ops carve-out; deletion entry uses sentinel + keyed ref
      "DeletedIdentity", // the barrier itself (keyed hash)
      "DeletionRecord", // operationId + keyed ref; expires after drain window
      "DeletionTask", // outbox; removed with its record
      "SubscriptionLineage", // provider keys + keyed deletedAccountRef
      "LineageTokenAlias",
      "LineagePeriodGrant", // pseudonymized retained financial data
      "LineagePeriodCustody",
      "SubscriptionTransfer",
      "LineageQuarantine",
    ]);
    // Ownerless infrastructure — carries no account correlation.
    const ownerless = new Set([
      "RuntimeConfig",
      "InviteCode",
      "InviteCodeRedemption",
      "AuthNonce",
      "GrantKind",
      "TelemetryBatch",
      "AgentVariant",
      "AgentPromptHint",
    ]);

    const accountCorrelatableFieldNames = [
      "accountId",
      "ownerAccountId",
      "fromAccountId",
      "toAccountId",
      "accountRef",
      "deletedAccountRef",
    ];

    for (const model of Prisma.dmmf.datamodel.models) {
      const known =
        deleted.has(model.name) ||
        retained.has(model.name) ||
        ownerless.has(model.name);
      expect(
        known,
        `Model ${model.name} is not in the deletion inventory — add it to the teardown or document its retention`,
      ).toBe(true);

      const correlatable = model.fields.some((f) =>
        accountCorrelatableFieldNames.includes(f.name),
      );
      if (correlatable && ownerless.has(model.name)) {
        throw new Error(
          `Model ${model.name} is marked ownerless but carries an account-correlatable field`,
        );
      }
    }
  });
});
