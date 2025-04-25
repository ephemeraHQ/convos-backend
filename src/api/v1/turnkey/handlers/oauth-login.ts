import type { Request, Response } from "express";
import { turnkeyClient, turnkeyConfig } from "../config";
import type {
  CreateSubOrgParams,
  OAuthLoginParams,
  OAuthLoginResponse,
} from "../types";
import { createSubOrgDirect } from "../utils/turnkey-helpers";

export async function oauthLogin(
  req: Request<object, object, OAuthLoginParams>,
  res: Response,
) {
  try {
    const { oidcToken, providerName, targetPublicKey, expirationSeconds } =
      req.body;

    let organizationId = turnkeyConfig.defaultOrganizationId;

    // Check if a sub-org already exists for this OAuth token
    const { organizationIds } = await turnkeyClient.getSubOrgIds({
      filterType: "OIDC_TOKEN",
      filterValue: oidcToken,
    });

    if (organizationIds.length > 0) {
      organizationId = organizationIds[0];
    } else {
      // Create a new sub-org for this OAuth user
      const subOrgParams: CreateSubOrgParams = {
        oauth: { oidcToken, providerName },
      };

      const result = await createSubOrgDirect(subOrgParams);
      organizationId = result.subOrganizationId;
    }

    // Authenticate via OAuth
    const oauthResponse = await turnkeyClient.oauth({
      organizationId,
      oidcToken,
      targetPublicKey,
      expirationSeconds,
    });

    const response: OAuthLoginResponse = {
      credentialBundle: oauthResponse.credentialBundle,
    };

    return res.status(200).json(response);
  } catch (error: unknown) {
    console.error("Error during OAuth login:", error);
    return res.status(500).json({ error: "Failed to authenticate with OAuth" });
  }
}
