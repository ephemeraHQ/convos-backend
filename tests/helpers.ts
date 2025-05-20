import type { Server } from "http";
import { getRandomValues } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Signer } from "@xmtp/node-sdk";
import * as jose from "jose";
import { createWalletClient, http, toBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { addressToIdentifier } from "@/utils/identifier";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testEncryptionKey = getRandomValues(new Uint8Array(32));

export const createUser = () => {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  return {
    key,
    account,
    wallet: createWalletClient({
      account,
      chain: sepolia,
      transport: http(),
    }),
  };
};

export const createSigner = (user: User): Signer => {
  return {
    type: "EOA",
    getIdentifier: () => addressToIdentifier(user.account.address),
    signMessage: async (message: string) => {
      const signature = await user.wallet.signMessage({
        message,
      });
      return toBytes(signature);
    },
  };
};

export type User = ReturnType<typeof createUser>;

export const createClient = async () => {
  const user = createUser();
  return Client.create(createSigner(user), {
    dbEncryptionKey: testEncryptionKey,
    env: process.env.XMTP_ENV as "local" | "dev" | "production",
    dbPath: join(__dirname, `./test-${user.account.address}.db3`),
  });
};

export const createHeaders = (client: Client, appCheckToken: string) => {
  const installationId = client.installationId;
  const inboxId = client.inboxId;
  const signature = client.signWithInstallationKey(appCheckToken);
  return {
    "X-Firebase-AppCheck": appCheckToken,
    "X-XMTP-InstallationId": installationId,
    "X-XMTP-InboxId": inboxId,
    "X-XMTP-Signature": toHex(signature),
  };
};

export const createJWT = async (client: Client, secret: string) => {
  const jwt = await new jose.SignJWT({
    inboxId: client.inboxId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  return jwt;
};

export const getServerPort = (server: Server) => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not get server address");
  }
  return address.port;
};
