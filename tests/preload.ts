import { mock } from "bun:test";
import type { SocialProfile } from "@/utils/thirdweb";

// Set required environment variables for tests
process.env.PUBLIC_ASSETS_BUCKET = "test-public-assets-bucket";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.FIREBASE_SERVICE_ACCOUNT = "{}";
process.env.XMTP_ENV = "local";
process.env.NOTIFICATION_SERVER_URL = "http://localhost:8080";
// Only set default if not already set (CI uses GitHub secrets)
process.env.XMTP_NOTIFICATION_SECRET =
  process.env.XMTP_NOTIFICATION_SECRET || "test-notification-secret";

// v2 JWT test keys (ECDSA P-256) - must be set before config.ts loads
process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGis9E4WiE4Ou51Ho
2tH6goYKt2nxLsKgadVvCYaklRyhRANCAARIw/oKiY4bkkW8iOcgiyUb1XPOtBQ4
/7NXGEExhSwpySP8P8tpOUlKoI2DryaYFx4EJhqtnV3Dhp1wLcxDKZYG
-----END PRIVATE KEY-----`;

process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESMP6ComOG5JFvIjnIIslG9VzzrQU
OP+zVxhBMYUsKckj/D/LaTlJSqCNg68mmBceBCYarZ1dw4adcC3MQymWBg==
-----END PUBLIC KEY-----`;

// mock Firebase functions

void mock.module("firebase-admin/app-check", () => ({
  getAppCheck: () => ({
    verifyToken: (token: string) => {
      if (token === "valid-app-check-token") {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error("Invalid AppCheck token"));
    },
    createToken: (_appId: string) => {
      return Promise.resolve({
        token: "valid-app-check-token",
      });
    },
  }),
}));

void mock.module("firebase-admin/app", () => ({
  initializeApp: () => {},
  cert: () => {},
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
