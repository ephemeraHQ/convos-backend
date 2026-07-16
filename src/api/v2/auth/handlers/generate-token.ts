import type { Request, Response } from "express";
import { z } from "zod";
import { isIdentityBarred } from "@/accounts/deletion/barrier";
import {
  IdentityBarredError,
  upsertAuthMethodAndAccount,
} from "@/accounts/repository";
import { requireLiveAccount } from "@/accounts/require-live-account";
import { consumeNonce } from "@/api/v2/auth/auth-nonce.repository";
import { InvalidSiweError, verifySiwe } from "@/api/v2/auth/handlers/siwe";
import {
  NONCE_COOKIE_CLEAR_FLAGS,
  NONCE_COOKIE_NAME,
  readNonceFromCookie,
} from "@/api/v2/auth/nonce-cookie";
import { config } from "@/payments/credits/config";
import { grantSignupBonusWithTx } from "@/payments/signup-bonus";
import { deviceIdSchema } from "@/utils/device-id";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

const siweSchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
});

const generateTokenRequestSchema = z.object({
  deviceId: deviceIdSchema,
  siwe: siweSchema.optional(),
});

export type IGenerateTokenRequestBody = z.infer<
  typeof generateTokenRequestSchema
>;

export async function generateToken(
  req: Request<unknown, unknown, IGenerateTokenRequestBody>,
  res: Response,
) {
  // 1. Body parse
  const parsed = generateTokenRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.errors }, "Invalid /auth/token body");
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const body = parsed.data;
  req.log.info(
    { deviceId: body.deviceId, hasSiwe: !!body.siwe },
    "Generating token",
  );

  // 2. Device-disabled check (before any nonce consumption)
  const device = await prisma.deviceRegistration.findUnique({
    where: { deviceId: body.deviceId },
  });
  if (device?.disabled) {
    req.log.warn({ deviceId: body.deviceId }, "Device is disabled");
    res.status(403).json({ error: "Device is disabled" });
    return;
  }

  let accountId: string | undefined;

  if (body.siwe) {
    // 3a. Read & verify nonce cookie (HMAC)
    // Defensive reads:
    //  - `req.cookies` may be undefined if cookieParser() is unmounted upstream.
    //  - cookie-parser parses `j:`-prefixed values as JSON, so the entry can be
    //    a non-string (object, array, etc.). Treat anything that isn't a plain
    //    string as missing, producing a clean 401 rather than a 500.
    const rawCookie = (req.cookies as Record<string, unknown> | undefined)?.[
      NONCE_COOKIE_NAME
    ];
    const cookieValue = typeof rawCookie === "string" ? rawCookie : undefined;
    const nonce = readNonceFromCookie(cookieValue);
    if (!nonce) {
      res.status(401).json({ error: "Invalid nonce" });
      return;
    }

    // 3b. Atomic single-use consume
    const consumed = await consumeNonce(nonce);
    if (!consumed) {
      res.status(401).json({ error: "Invalid nonce" });
      return;
    }

    // 3c. Verify SIWE message + signature
    let address: string;
    try {
      const result = await verifySiwe({
        message: body.siwe.message,
        signature: body.siwe.signature,
        expectedNonce: nonce,
        expectedDeviceId: body.deviceId,
        now: new Date(),
      });
      address = result.address;
    } catch (err) {
      if (err instanceof InvalidSiweError) {
        req.log.warn({ reason: err.reason }, "SIWE verification failed");
        res.status(401).json({ error: "Invalid SIWE" });
        return;
      }
      throw err;
    }

    // 3d. Deletion barrier. Checked only after full SIWE validation succeeded
    // (never for bad nonce/signature — no unauthenticated deletion oracle).
    // A barred identity gets the terminal identity-deleted response, the one
    // signal clients may treat as deletion confirmation, and never reaches
    // the auto-provisioning upsert below (so no account or signup bonus can
    // ever be silently recreated).
    try {
      if (await isIdentityBarred("SIWE", address)) {
        req.log.info(
          { deviceId: body.deviceId },
          "auth.token.identity_deleted",
        );
        res.status(410).json({
          error: "This identity has been deleted",
          code: "identity_deleted",
        });
        return;
      }
    } catch (err) {
      req.log.error({ err }, "auth.token.barrier_check_failed");
      res.status(500).json({ error: "Failed to generate token" });
      return;
    }

    // 3e. Upsert Account + AuthMethod. On first creation, grant the signup
    // bonus inside the same transaction (atomic) so a new account can never
    // exist without its bonus. A failure rolls the account back and surfaces
    // as a retryable 500 rather than silently dropping the bonus.
    // The upsert re-checks the deletion barrier inside its own transaction
    // under the per-identity advisory lock (shared with the teardown), so a
    // deletion committing after the pre-check above can never be followed by
    // a silent account re-creation — it surfaces here as IdentityBarredError.
    let upserted: { accountId: string; created: boolean };
    try {
      upserted = await upsertAuthMethodAndAccount({
        type: "SIWE",
        externalKey: address,
        onCreate:
          config.signupBonusCredits > 0
            ? (tx, newAccountId) =>
                grantSignupBonusWithTx(
                  tx,
                  newAccountId,
                  config.signupBonusCredits,
                )
            : undefined,
      });
    } catch (err) {
      if (err instanceof IdentityBarredError) {
        req.log.info(
          { deviceId: body.deviceId },
          "auth.token.identity_deleted",
        );
        res.status(410).json({
          error: "This identity has been deleted",
          code: "identity_deleted",
        });
        return;
      }
      req.log.error({ err }, "auth.account.create_failed");
      res.status(500).json({ error: "Failed to create account" });
      return;
    }
    accountId = upserted.accountId;

    // Best-effort backfill of DeviceRegistration.accountId.
    //
    // Runs in its own small transaction, SEPARATE from the upsert
    // transaction. A transient DB issue here cannot fail token mint
    // (try/catch below). updateMany silently no-ops when the device row
    // doesn't exist (legitimate case: client called /auth/token before
    // /device/register). Self-heals on next mint after device registers.
    //
    // Concurrency: a `SELECT ... FOR UPDATE` on the device row serializes
    // concurrent backfills targeting the same deviceId. Without the lock,
    // commit order can diverge from request-arrival order, so a slower
    // older request can overwrite a faster newer one. With the lock, the
    // second request blocks until the first commits, so the request that
    // acquires the lock last is also the one whose value ends up in the
    // column — restoring "later request wins" semantics for the sequential
    // wallet-switch case. Truly simultaneous arrivals resolve to lock
    // acquisition order (non-deterministic, but final state is still a
    // valid one of the two — no torn writes).
    if (device?.accountId === accountId) {
      req.log.info(
        { deviceId: body.deviceId, accountId },
        "auth.device.account_backfill_noop",
      );
    } else {
      try {
        const count = await prisma.$transaction(async (tx) => {
          // Account lock first (lock-order law: Account before the device
          // row) — fences the backfill against a concurrent deletion of this
          // account. AccountNotLiveError lands in the fail-soft catch below.
          await requireLiveAccount(tx, upserted.accountId);
          // Acquire row-level lock; no-op if device row doesn't exist
          // (returns 0 rows, no lock taken, subsequent updateMany also 0).
          await tx.$queryRaw`
            SELECT 1 FROM "DeviceRegistration"
            WHERE "deviceId" = ${body.deviceId}
            FOR UPDATE
          `;
          const result = await tx.deviceRegistration.updateMany({
            where: { deviceId: body.deviceId },
            data: { accountId },
          });
          return result.count;
        });
        if (count > 0) {
          req.log.info(
            { deviceId: body.deviceId, accountId },
            "auth.device.account_backfill",
          );
        } else {
          req.log.info(
            { deviceId: body.deviceId, accountId },
            "auth.device.account_backfill_noop",
          );
        }
      } catch (err) {
        req.log.warn(
          { err, deviceId: body.deviceId, accountId },
          "auth.device.account_backfill_failed",
        );
      }
    }
  }

  // 4. Mint JWT
  let token: string;
  try {
    token = await createJwtToken({
      deviceId: body.deviceId,
      accountId,
      expirationTime: "15m",
    });
  } catch (err) {
    req.log.error({ err }, "Failed to mint JWT");
    res.status(500).json({ error: "Failed to generate token" });
    return;
  }

  // 5. Clear nonce cookie on successful SIWE upgrade
  if (body.siwe) {
    res.append(
      "Set-Cookie",
      `${NONCE_COOKIE_NAME}=; ${NONCE_COOKIE_CLEAR_FLAGS}`,
    );
  }

  res.json({ token });
}
