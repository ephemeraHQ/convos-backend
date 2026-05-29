import type { Request, Response } from "express";
import { z } from "zod";
import { hashApnsToken } from "@/notifications/hash";
import { verifyDeviceOwnership } from "@/utils/auth-guards";
import { deviceIdSchema } from "@/utils/device-id";
import { prisma } from "@/utils/prisma";

/**
 * Stack 2 T12: production-safe push registration status endpoint.
 *
 * iOS calls this from the DebugPushNotificationsView "Probe backend
 * registration" button. The response is JWT-gated, hashes-only, and
 * rate-limited (1/sec/JWT via debugStatusLimiter at the route mount).
 * Production-safe means: every field is either a boolean, a count, a
 * timestamp, or a hash. No raw push token, no raw topic strings, no
 * JWT echo. The negative test on this handler is "the JSON response
 * never contains the raw pushToken value or any topic string".
 *
 * The plan's D5 also says "scoped by JWT accountId + JWT deviceId, not
 * just deviceId". We enforce both: verifyDeviceOwnership for the
 * deviceId, plus an explicit accountId match against the looked-up
 * device row.
 *
 * The snapshot fields are returned as "last requested topic state" —
 * NOT actual remote XMTP notification server state. iOS clients MUST
 * label them that way in the UI; the response includes
 * `isActualRemoteState: false` as a permanent reminder.
 */

const debugStatusRequestSchema = z.object({
  deviceId: deviceIdSchema,
  clientId: z.string().uuid(),
  pushTokenSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Expected 64-char lowercase hex")
    .optional(),
  pushTokenType: z.enum(["apns", "fcm"]).optional(),
  apnsEnv: z.enum(["sandbox", "production"]).nullable().optional(),
});

export type IDebugStatusRequestBody = z.infer<typeof debugStatusRequestSchema>;

interface DebugStatusResponse {
  device: {
    exists: boolean;
    hasPushToken: boolean;
    pushTokenMatches: boolean | null;
    pushTokenTypeMatches: boolean | null;
    apnsEnvMatches: boolean | null;
    disabled: boolean | null;
    pushFailures: number | null;
    lastSentAt: string | null;
    lastFailureAt: string | null;
    updatedAt: string | null;
  };
  client: {
    exists: boolean;
    mappedDeviceId: string | null;
    deviceIdMatchesJwt: boolean | null;
    accountIdMatchesJwt: boolean | null;
    updatedAt: string | null;
  };
  subscriptionSnapshot: {
    exists: boolean;
    topicCount: number | null;
    topicHash: string | null;
    // Presence flags only - raw kindSummary and lastRemoteApplyError can
    // carry attacker-controlled topic strings or upstream error text and
    // would break this endpoint's hashes-only contract if returned verbatim.
    hasKindSummary: boolean;
    lastContext: string | null;
    lastSubscribeAt: string | null;
    lastRemoteApplySucceeded: boolean | null;
    hasLastRemoteApplyError: boolean;
    pushTokenMatchesAtApply: boolean | null;
    apnsEnvMatchesAtApply: boolean | null;
    isActualRemoteState: false;
  };
}

export async function debugStatus(
  req: Request<unknown, unknown, IDebugStatusRequestBody>,
  res: Response,
) {
  try {
    const body = debugStatusRequestSchema.parse(req.body);

    const jwtDeviceId = res.locals.deviceId;
    const jwtAccountId = res.locals.accountId;

    req.log.info(
      {
        accountId: jwtAccountId,
        deviceId: body.deviceId,
        clientId: body.clientId,
        hasPushTokenSha256: !!body.pushTokenSha256,
      },
      "Debug status probe",
    );

    // The endpoint is scoped by JWT accountId + JWT deviceId. A device-only
    // JWT (legacy /v2/auth/token without SIWE) must not get diagnostic state.
    if (!jwtAccountId) {
      req.log.warn(
        { deviceId: body.deviceId },
        "Debug status rejected - JWT has no accountId",
      );
      res.status(403).json({ error: "Account required" });
      return;
    }

    if (
      !verifyDeviceOwnership({
        req,
        res,
        jwtDeviceId,
        expectedDeviceId: body.deviceId,
      })
    ) {
      return;
    }

    const [device, client] = await Promise.all([
      prisma.deviceRegistration.findUnique({
        where: { deviceId: body.deviceId },
      }),
      prisma.clientIdentifier.findUnique({
        where: { id: body.clientId },
      }),
    ]);

    // Reject when the stored device row belongs to a different account than
    // the JWT. A device row exists but with a different accountId means the
    // device was re-paired to another account; we must not leak that account's
    // diagnostic state. A NULL device.accountId is allowed - that covers
    // pre-backfill device rows that the JWT account already owns.
    if (device && device.accountId && device.accountId !== jwtAccountId) {
      req.log.warn(
        {
          jwtAccountId,
          deviceAccountId: device.accountId,
          deviceId: body.deviceId,
        },
        "Debug status rejected - device account mismatch",
      );
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const snapshot = await prisma.notificationSubscriptionSnapshot.findUnique({
      where: { clientId: body.clientId },
    });

    // Hash the stored push token at read time so we never put the raw
    // token in the response. The hashApnsToken util returns "none" for
    // the no-token case, so the equality check below correctly says
    // "no, doesn't match" when the device has no token.
    const storedPushTokenSha = hashApnsToken(device?.pushToken);

    const response: DebugStatusResponse = {
      device: {
        exists: device !== null,
        hasPushToken: !!device?.pushToken,
        pushTokenMatches: device?.pushToken
          ? body.pushTokenSha256 !== undefined
            ? body.pushTokenSha256 === storedPushTokenSha
            : null
          : false,
        pushTokenTypeMatches: device
          ? body.pushTokenType !== undefined
            ? body.pushTokenType === device.pushTokenType
            : null
          : null,
        apnsEnvMatches: device
          ? body.apnsEnv !== undefined
            ? body.apnsEnv === device.apnsEnv
            : null
          : null,
        disabled: device?.disabled ?? null,
        pushFailures: device?.pushFailures ?? null,
        lastSentAt: device?.lastSentAt?.toISOString() ?? null,
        lastFailureAt: device?.lastFailureAt?.toISOString() ?? null,
        updatedAt: device ? device.updatedAt.toISOString() : null,
      },
      client: {
        exists: client !== null,
        mappedDeviceId: client?.deviceId ?? null,
        deviceIdMatchesJwt: client ? client.deviceId === jwtDeviceId : null,
        accountIdMatchesJwt: client ? client.accountId === jwtAccountId : null,
        updatedAt: client ? client.updatedAt.toISOString() : null,
      },
      subscriptionSnapshot: {
        exists: snapshot !== null,
        topicCount: snapshot?.topicCount ?? null,
        topicHash: snapshot?.topicHash ?? null,
        hasKindSummary: snapshot?.kindSummary != null,
        lastContext: snapshot?.lastContext ?? null,
        lastSubscribeAt: snapshot
          ? snapshot.lastSubscribeAt.toISOString()
          : null,
        lastRemoteApplySucceeded: snapshot?.lastRemoteApplySucceeded ?? null,
        hasLastRemoteApplyError: snapshot?.lastRemoteApplyError != null,
        pushTokenMatchesAtApply:
          snapshot && device?.pushToken
            ? snapshot.pushTokenSha256AtApply === storedPushTokenSha
            : null,
        apnsEnvMatchesAtApply:
          snapshot && device
            ? snapshot.apnsEnvAtApply === device.apnsEnv
            : null,
        isActualRemoteState: false,
      },
    };

    res.status(200).json(response);
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request body for debug-status",
      );
      res.status(400).json({
        error: "Invalid request body",
        details: error.errors,
      });
      return;
    }
    req.log.error({ error }, "Failed to read debug status");
    res.status(500).json({ error: "Failed to read debug status" });
    return;
  }
}
