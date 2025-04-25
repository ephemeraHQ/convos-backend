import { DEFAULT_ETHEREUM_ACCOUNTS } from "@turnkey/sdk-server";
import { decodeJwt } from "../../../../utils/turnkey-utils";
import { turnkeyClient, turnkeyConfig } from "../config";
import type { CreateSubOrgParams } from "../types";

export async function createSubOrgDirect(params: CreateSubOrgParams) {
  const { passkey, oauth } = params;

  const authenticators = passkey
    ? [
        {
          authenticatorName: "Passkey",
          challenge: passkey.challenge,
          attestation: passkey.attestation,
        },
      ]
    : [];

  const oauthProviders = oauth
    ? [
        {
          providerName: oauth.providerName,
          oidcToken: oauth.oidcToken,
        },
      ]
    : [];

  // Get email from oauth token if available
  let userEmail: string | undefined;
  if (oauth) {
    const decoded = decodeJwt(oauth.oidcToken);
    if (decoded?.email && typeof decoded.email === "string") {
      userEmail = decoded.email;
    }
  }

  // Generate organization name and username
  const subOrganizationName = userEmail
    ? `Sub Org - ${userEmail}`
    : "Passkey Sub Org";
  const userName = userEmail
    ? userEmail.split("@")[0] || userEmail
    : "passkey-user";

  const result = await turnkeyClient.createSubOrganization({
    organizationId: turnkeyConfig.defaultOrganizationId,
    subOrganizationName,
    rootUsers: [
      {
        userName,
        userEmail,
        oauthProviders,
        authenticators,
        apiKeys: [],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: "Default Wallet",
      accounts: DEFAULT_ETHEREUM_ACCOUNTS,
    },
  });

  return {
    subOrganizationId: result.subOrganizationId,
  };
}
