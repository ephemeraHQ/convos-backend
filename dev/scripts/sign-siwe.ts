/**
 * SIWE message signer CLI for local E2E demo.
 *
 * Usage:
 *   bun run dev/scripts/sign-siwe.ts --nonce <hex> [flags...]
 *
 * Outputs JSON {"message": "...", "signature": "..."} to stdout.
 *
 * Each flag maps to a negative case in dev/scripts/run-e2e-demo.sh.
 * See docs/superpowers/specs/2026-05-11-local-e2e-auth-demo-design.md.
 */
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";

interface Args {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  signerKey: `0x${string}`;
  addressOverride?: `0x${string}`;
  expOffsetMs: number;
  iatOffsetMs: number;
  nbfOffsetMs?: number;
  noExpiration: boolean;
  tamperVersion?: string;
  statement: string;
  out: "json" | "message" | "signature";
}

const DEFAULT_SIGNER_KEY: `0x${string}` = `0x${"1".repeat(64)}`;

function parseDurationMs(input: string): number {
  // Accepts forms like "5m", "+5m", "-1m", "30s", "0s", "1h".
  const match = /^([+-]?)(\d+)(ms|s|m|h)$/.exec(input);
  if (!match) throw new Error(`invalid duration: "${input}"`);
  const sign = match[1] === "-" ? -1 : 1;
  const n = parseInt(match[2], 10);
  const unit = match[3];
  const mult =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return sign * n * mult;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    nonce: "",
    domain: "convos.app",
    uri: "https://convos.app",
    chainId: 1,
    signerKey: DEFAULT_SIGNER_KEY,
    expOffsetMs: 5 * 60_000,
    iatOffsetMs: 0,
    noExpiration: false,
    statement: "Sign in to Convos",
    out: "json",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      i++;
      if (i >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[i];
    };
    switch (flag) {
      case "--nonce":
        args.nonce = next();
        break;
      case "--domain":
        args.domain = next();
        break;
      case "--uri":
        args.uri = next();
        break;
      case "--chain-id": {
        const raw = next();
        if (!/^[0-9]+$/.test(raw))
          throw new Error(`invalid --chain-id: "${raw}"`);
        args.chainId = parseInt(raw, 10);
        break;
      }
      case "--signer-key":
        args.signerKey = next() as `0x${string}`;
        break;
      case "--address-override":
        args.addressOverride = next() as `0x${string}`;
        break;
      case "--exp-offset":
        args.expOffsetMs = parseDurationMs(next());
        break;
      case "--iat-offset":
        args.iatOffsetMs = parseDurationMs(next());
        break;
      case "--nbf-offset":
        args.nbfOffsetMs = parseDurationMs(next());
        break;
      case "--no-expiration":
        args.noExpiration = true;
        break;
      case "--tamper-version":
        args.tamperVersion = next();
        break;
      case "--statement":
        args.statement = next();
        break;
      case "--out": {
        const v = next();
        if (v !== "json" && v !== "message" && v !== "signature") {
          throw new Error(`--out must be json|message|signature`);
        }
        args.out = v;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.nonce) throw new Error("--nonce <hex> is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const account = privateKeyToAccount(args.signerKey);
  const address = args.addressOverride ?? account.address;

  const now = new Date();
  const issuedAt = new Date(now.getTime() + args.iatOffsetMs).toISOString();
  const expirationTime = args.noExpiration
    ? undefined
    : new Date(now.getTime() + args.expOffsetMs).toISOString();
  const notBefore =
    args.nbfOffsetMs === undefined
      ? undefined
      : new Date(now.getTime() + args.nbfOffsetMs).toISOString();

  const msg = new SiweMessage({
    domain: args.domain,
    address,
    statement: args.statement,
    uri: args.uri,
    version: "1",
    chainId: args.chainId,
    nonce: args.nonce,
    issuedAt,
    ...(expirationTime ? { expirationTime } : {}),
    ...(notBefore ? { notBefore } : {}),
  });
  let messageStr = msg.prepareMessage();
  const signature = await account.signMessage({ message: messageStr });

  if (args.tamperVersion) {
    messageStr = messageStr.replace(
      /^Version: 1$/m,
      `Version: ${args.tamperVersion}`,
    );
  }

  if (args.out === "message") {
    process.stdout.write(messageStr);
    return;
  }
  if (args.out === "signature") {
    process.stdout.write(signature);
    return;
  }
  process.stdout.write(JSON.stringify({ message: messageStr, signature }));
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
