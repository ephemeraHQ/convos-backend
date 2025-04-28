import type { TurnkeySDKServerConfig } from "@turnkey/sdk-server";

export const getTurnkeyConfig = (): TurnkeySDKServerConfig => {
  if (!process.env.TURNKEY_API_PUBLIC_KEY) {
    throw new Error("TURNKEY_API_PUBLIC_KEY is not set");
  }
  if (!process.env.TURNKEY_API_PRIVATE_KEY) {
    throw new Error("TURNKEY_API_PRIVATE_KEY is not set");
  }
  if (!process.env.TURNKEY_ORGANIZATION_ID) {
    throw new Error("TURNKEY_ORGANIZATION_ID is not set");
  }

  return {
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL || "https://api.turnkey.com",
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
  };
};
