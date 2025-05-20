import { mock } from "bun:test";
import type { SocialProfile } from "@/utils/thirdweb";

// mock Firebase functions

void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: (token: string) => {
      if (token === "valid-app-check-token") {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error("Invalid AppCheck token"));
    },
  }),
}));

void mock.module("firebase-admin", () => ({
  credential: {
    cert: () => {},
  },
}));

void mock.module("firebase-admin/app", () => ({
  initializeApp: () => {},
}));

// Mock thirdweb functions
void mock.module("@/utils/thirdweb", () => ({
  checkNameOwnership: (args: { address: string; name: string }) => {
    // Return true only for vitalik.eth owned by the specific address
    return (
      args.name === "vitalik.eth" &&
      args.address === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
    );
  },
  getSocialProfilesForAddress: (args: { address: string }) => {
    if (args.address === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045") {
      return [
        {
          type: "ens",
          address: args.address,
          name: "vitalik.eth",
        },
      ] satisfies SocialProfile[];
    }
    return [];
  },
}));

// Mock XMTP functions
void mock.module("@/utils/xmtp", () => ({
  getAddressesForInboxId: (inboxId: string) => {
    // For testing successful case
    if (inboxId === "vitalik-xmtp-id") {
      return ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"];
    }
    // For testing failure case
    return ["0x1234567890123456789012345678901234567890"];
  },
}));

void mock.module("@/api/v1/wallets/utils", () => ({
  getTurnkeyConfig: () => {},
}));
