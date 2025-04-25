import { type TurnkeyApiTypes } from "@turnkey/sdk-server";

export type GetSubOrgIdParams = {
  filterType:
    | "NAME"
    | "USERNAME"
    | "EMAIL"
    | "CREDENTIAL_ID"
    | "PUBLIC_KEY"
    | "OIDC_TOKEN";
  filterValue: string;
};

export type GetSubOrgIdResponse = {
  organizationId: string;
};

export type CreateSubOrgParams = {
  passkey?: {
    name?: string;
    challenge: string;
    attestation: Attestation;
  };
  oauth?: OAuthProviderParams;
};

export type CreateSubOrgResponse = {
  subOrganizationId: string;
};

export type OAuthProviderParams = {
  providerName: string;
  oidcToken: string;
};

export type OAuthLoginParams = {
  oidcToken: string;
  providerName: string;
  targetPublicKey: string;
  expirationSeconds: string;
};

export type OAuthLoginResponse = {
  credentialBundle: string;
};

export type Attestation = TurnkeyApiTypes["v1Attestation"];
