import { Turnkey } from "@turnkey/sdk-server";

export const turnkeyConfig = {
  apiBaseUrl: process.env.TURNKEY_API_URL ?? "",
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY ?? "",
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY ?? "",
};

export const turnkeyClient = new Turnkey(turnkeyConfig).apiClient();
