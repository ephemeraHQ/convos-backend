import { getRandomValues } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@xmtp/node-sdk";
import { createWalletClient, http, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

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

export const createSigner = (user: User) => {
  return {
    getAddress: () => user.account.address,
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
  return Client.create(createSigner(user), testEncryptionKey, {
    env: "local",
    dbPath: join(__dirname, `./test-${user.account.address}.db3`),
  });
};
