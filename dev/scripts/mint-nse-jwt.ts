/**
 * NSE JWT mint CLI for local E2E demo.
 *
 * Mints a JWT with metadata.notificationExtensionOnly: true, used by the
 * demo to prove backward-compat behavior (NSE allowed on /auth-check,
 * rejected on /account-auth-check).
 *
 * Usage:
 *   bun run dev/scripts/mint-nse-jwt.ts --device-id <id> [--expiration <duration>]
 *
 * Outputs the raw JWT string to stdout.
 */

interface Args {
  deviceId: string;
  expiration: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { deviceId: "", expiration: "12h" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length) {
        throw new Error(`${flag} requires a value`);
      }
      const v = argv[++i];
      if (v.startsWith("--")) {
        throw new Error(
          `${flag} requires a value (got flag-looking token: "${v}")`,
        );
      }
      return v;
    };
    switch (flag) {
      case "--device-id":
        args.deviceId = next();
        break;
      case "--expiration":
        args.expiration = next();
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.deviceId) throw new Error("--device-id <id> is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Defer import until after arg validation so missing --device-id exits cleanly
  // without triggering config.ts env-var checks.
  const { createJwtToken } = await import("@/utils/jwt");
  const token = await createJwtToken({
    deviceId: args.deviceId,
    metadata: { notificationExtensionOnly: true },
    expirationTime: args.expiration,
  });
  process.stdout.write(token);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
