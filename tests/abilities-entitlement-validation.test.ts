import { describe, test } from "vitest";
import { entitlementCompleteBodySchema } from "@/api/v2/abilities/handlers/entitlement-complete";
import { entitlementPostBodySchema } from "@/api/v2/abilities/handlers/entitlement-post";
import { conversationAbilityDeleteQuerySchema } from "@/api/v2/conversations/handlers/ability-delete";
import { conversationAbilityPutBodySchema } from "@/api/v2/conversations/handlers/ability-put";
import { assertLegacyShapeValidates } from "./helpers/assertLegacyShapeValidates";

// Append-only contract pins for the Connections V2 request schemas (see
// CLAUDE.md): each shape below is what a shipped client build sends. A future
// tightening that stops accepting one fails here instead of 400ing users in
// production. No DB required.

describe("abilities entitlement request contracts", () => {
  test("bind body: empty and with a redirect", () => {
    // The body is entirely optional — a bare POST must keep validating.
    assertLegacyShapeValidates(entitlementPostBodySchema, {}, "bind {}");
    assertLegacyShapeValidates(
      entitlementPostBodySchema,
      { redirectUri: "convos-dev://connections/callback" },
      "bind {redirectUri}",
    );
  });

  test("complete body", () => {
    assertLegacyShapeValidates(
      entitlementCompleteBodySchema,
      { connectionRequestId: "ca_0123456789" },
      "complete {connectionRequestId}",
    );
  });

  test("extend body: without and with the optional extender inbox id", () => {
    assertLegacyShapeValidates(
      conversationAbilityPutBodySchema,
      { agentInboxId: "agent-inbox-1", bundleIds: ["calendar.events"] },
      "extend {agentInboxId, bundleIds}",
    );
    assertLegacyShapeValidates(
      conversationAbilityPutBodySchema,
      {
        agentInboxId: "agent-inbox-1",
        bundleIds: ["calendar.events"],
        extendedByInboxId: "owner-inbox-1",
      },
      "extend {agentInboxId, bundleIds, extendedByInboxId}",
    );
  });

  test("withdraw query", () => {
    assertLegacyShapeValidates(
      conversationAbilityDeleteQuerySchema,
      { agentInboxId: "agent-inbox-1" },
      "withdraw {agentInboxId}",
    );
  });
});
