import { Wallet } from "ethers";
import { SiweMessage } from "siwe";

export const DEFAULT_TEST_PRIVATE_KEY = "0x" + "1".repeat(64);

export interface BuildSiweArgs {
  deviceId: string;
  nonce: string;
  signerKey?: string;
  now?: Date;
  /** Override any SiweMessage field. Pass `resources: []` to omit the device URI. */
  overrides?: Partial<SiweMessage>;
}

export interface BuiltSiwe {
  messageStr: string;
  signature: string;
  address: string;
  deviceId: string;
}

export async function buildSiweMessage(
  args: BuildSiweArgs,
): Promise<BuiltSiwe> {
  const wallet = new Wallet(args.signerKey ?? DEFAULT_TEST_PRIVATE_KEY);
  const now = args.now ?? new Date();
  const base: Partial<SiweMessage> = {
    domain: "convos.app",
    address: wallet.address,
    statement: "Sign in to Convos",
    uri: "https://convos.app",
    version: "1",
    chainId: 1,
    nonce: args.nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60_000).toISOString(),
    resources: [`convos://device/${args.deviceId}`],
  };
  const msg = new SiweMessage({ ...base, ...(args.overrides ?? {}) });
  const messageStr = msg.prepareMessage();
  const signature = await wallet.signMessage(messageStr);
  return {
    messageStr,
    signature,
    address: wallet.address.toLowerCase(),
    deviceId: args.deviceId,
  };
}
