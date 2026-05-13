import type { Request, Response } from "express";
import { z } from "zod";
import { upsertAuthMethodAndAccount } from "@/accounts/repository";
import { consumeNonce } from "@/api/v2/auth/auth-nonce.repository";
import { InvalidSiweError, verifySiwe } from "@/api/v2/auth/handlers/siwe";
import {
  NONCE_COOKIE_CLEAR_FLAGS,
  NONCE_COOKIE_NAME,
  readNonceFromCookie,
} from "@/api/v2/auth/nonce-cookie";
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

    // 3d. Upsert Account + AuthMethod
    const upserted = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: address,
    });
    accountId = upserted.accountId;

    // Best-effort backfill of DeviceRegistration.accountId.
    // Runs OUTSIDE the upsert transaction so a transient DB issue here
    // can't fail token mint. updateMany silently no-ops when the device
    // row doesn't exist (legitimate case: client called /auth/token
    // before /device/register). Self-heals on next mint after device
    // registers. Last-write-wins on wallet switch by design.
    try {
      const { count } = await prisma.deviceRegistration.updateMany({
        where: { deviceId: body.deviceId },
        data: { accountId },
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
