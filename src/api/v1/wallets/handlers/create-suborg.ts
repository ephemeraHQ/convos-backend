import { Turnkey as TurnkeyServerSDK } from "@turnkey/sdk-server";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import {
  API_KEY_EXPIRATION_TIME,
  DEFAULT_API_KEY_NAME,
  DEFAULT_SUB_ORG_NAME,
  DEFAULT_USER_NAME,
  ETHEREUM_WALLET_DEFAULT_PATH,
} from "../constants";
import { getTurnkeyConfig } from "../utils";

const turnkeyConfig = getTurnkeyConfig();

export const createSubOrgRequestBodySchema = z.object({
  challenge: z.string(),
  attestation: z.object({
    /** @description The cbor encoded then base64 url encoded id of the credential. */
    credentialId: z.string(),
    /** @description A base64 url encoded payload containing metadata about the signing context and the challenge. */
    clientDataJson: z.string(),
    /** @description A base64 url encoded payload containing authenticator data and any attestation the webauthn provider chooses. */
    attestationObject: z.string(),
    /** @description The type of authenticator transports. */
    transports: z.array(
      z.enum([
        "AUTHENTICATOR_TRANSPORT_BLE",
        "AUTHENTICATOR_TRANSPORT_INTERNAL",
        "AUTHENTICATOR_TRANSPORT_NFC",
        "AUTHENTICATOR_TRANSPORT_USB",
        "AUTHENTICATOR_TRANSPORT_HYBRID",
      ]),
    ),
  }),
  ephemeralPublicKey: z.string().optional(),
});

export type CreateSubOrgRequestBody = z.infer<
  typeof createSubOrgRequestBodySchema
>;

export type CreateSubOrgReturned = {
  subOrgId: string;
  walletAddress: string;
};

export async function createSubOrg(
  req: Request<unknown, unknown, CreateSubOrgRequestBody>,
  res: Response,
) {
  try {
    let body;
    try {
      body = await createSubOrgRequestBodySchema.parseAsync(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          errors: {
            challenge:
              error.errors.find((e) => e.path.join(".") === "challenge")
                ?.message || "Challenge is required",
            attestation:
              error.errors.find((e) =>
                e.path.join(".").startsWith("attestation"),
              )?.message || "Attestation is required",
          },
        });
        return;
      }
      throw error;
    }

    const { challenge, attestation, ephemeralPublicKey } = body;
    const walletName = `Default Wallet`;

    const turnkeyClient = new TurnkeyServerSDK(turnkeyConfig);

    const completedActivity = await turnkeyClient
      .apiClient()
      .createSubOrganization({
        subOrganizationName: DEFAULT_SUB_ORG_NAME,
        rootQuorumThreshold: 1,
        rootUsers: [
          {
            userName: DEFAULT_USER_NAME,
            apiKeys: ephemeralPublicKey
              ? [
                  {
                    apiKeyName: DEFAULT_API_KEY_NAME,
                    publicKey: ephemeralPublicKey,
                    curveType: "API_KEY_CURVE_P256",
                    expirationSeconds: API_KEY_EXPIRATION_TIME.toString(),
                  },
                ]
              : [],
            authenticators: [
              {
                authenticatorName: "Passkey",
                challenge: challenge,
                attestation: attestation,
              },
            ],
            oauthProviders: [],
          },
        ],
        wallet: {
          walletName,
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              pathFormat: "PATH_FORMAT_BIP32",
              path: ETHEREUM_WALLET_DEFAULT_PATH,
              addressFormat: "ADDRESS_FORMAT_ETHEREUM",
            },
          ],
        },
      });

    const subOrgId = refineNonNull(completedActivity.subOrganizationId);
    const wallet = refineNonNull(completedActivity.wallet);
    const walletAddress = wallet.addresses[0];

    // Create the SubOrg
    const createdSubOrg = await prisma.subOrg.create({
      data: {
        defaultWalletAddress: walletAddress,
        id: subOrgId,
      },
      select: {
        id: true,
        defaultWalletAddress: true,
      },
    });

    req.log.info(
      {
        subOrgId: createdSubOrg.id,
        walletAddress: createdSubOrg.defaultWalletAddress,
      },
      "suborg created",
    );

    res.status(201).json({
      subOrgId: createdSubOrg.id,
      walletAddress: createdSubOrg.defaultWalletAddress,
    });
  } catch (error) {
    console.error("Error creating suborg:", error);
    res.status(500).json({ error: "Failed to create suborg" });
  }
}

function refineNonNull<T>(
  input: T | null | undefined,
  errorMessage?: string,
): T {
  if (input == null) {
    throw new Error(errorMessage ?? `Unexpected ${JSON.stringify(input)}`);
  }

  return input;
}
