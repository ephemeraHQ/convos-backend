import { ApnsEnvironmentSchema } from "@prisma-zod/index";
import { PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const installationItemSchema = z.object({
  identityId: z.string(),
  xmtpInstallationId: z.string(),
});

const currentRegistrationSchema = z.object({
  deviceId: z.string(),
  pushToken: z.string(),
  pushTokenType: z.nativeEnum(PushTokenType).optional(),
  apnsEnv: ApnsEnvironmentSchema.nullable(),
  // List of installations to register
  // We will also check for any other identities on device that don't have any of those installations and delete them
  installations: z.array(installationItemSchema),
});

const legacyRegistrationSchema = z.object({
  installationId: z.string(),
  deliveryMechanism: z.object({
    deliveryMechanismType: z.object({
      case: z.enum(["apnsDeviceToken", "firebaseDeviceToken", "customToken"]),
      value: z.string(),
    }),
  }),
});

const registerInstallationResponseSchema = z.array(
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("success"),
      xmtpInstallationId: z.string(),
      validUntil: z.number(),
    }),
    z.object({
      status: z.literal("error"),
    }),
  ]),
);

export type IRegisterInstallationResponse = z.infer<
  typeof registerInstallationResponseSchema
>;

export type ICurrentRegisterInstallationRequestBody = z.infer<
  typeof currentRegistrationSchema
>;

export type ILegacyRegisterInstallationRequestBody = z.infer<
  typeof legacyRegistrationSchema
>;

const notificationClient = createNotificationClient();

export async function registerInstallation(
  req: Request<unknown, unknown, ICurrentRegisterInstallationRequestBody>,
  res: Response,
) {
  const legacyParseResult = legacyRegistrationSchema.safeParse(req.body);
  if (legacyParseResult.success) {
    await handleLegacyRegistration({
      res,
      body: legacyParseResult.data,
    });
    return;
  }

  const currentParseResult = currentRegistrationSchema.safeParse(req.body);
  if (currentParseResult.success) {
    await handleCurrentRegistration({
      req,
      res,
      body: currentParseResult.data,
    });
    return;
  }

  res.status(400).json({ error: "Invalid request body" });
}

async function handleCurrentRegistration(args: {
  req: Request<unknown, unknown, ICurrentRegisterInstallationRequestBody>;
  res: Response;
  body: ICurrentRegisterInstallationRequestBody;
}) {
  const { req, res, body } = args;

  try {
    const authenticatedXmtpId = res.locals.xmtpId;

    // Ensure the authenticated identity exists
    const deviceIdentityForAuthenticatedUser =
      await prisma.deviceIdentity.findFirst({
        where: { xmtpId: authenticatedXmtpId },
        select: { id: true },
      });

    if (!deviceIdentityForAuthenticatedUser) {
      res
        .status(403)
        .json({ error: "Forbidden: Authenticated user not found" });
      return;
    }

    // Make sure the device belongs to the authenticated identity
    const deviceOwnerCheck = await prisma.device.findUnique({
      where: { id: body.deviceId },
      select: { identities: true },
    });

    if (
      !deviceOwnerCheck ||
      !deviceOwnerCheck.identities.some(
        (entry) => entry.identityId === deviceIdentityForAuthenticatedUser.id,
      )
    ) {
      req.log.warn(
        `Identity ${deviceIdentityForAuthenticatedUser.id} attempt to register for unowned/unknown device ${body.deviceId}`,
      );
      res.status(403).json({ error: "Forbidden: Device access denied" });
      return;
    }

    // Make sure all the identities being registered belong to the authenticated user
    let xmtpIdToIdentityIdMap = new Map<string, string>();
    if (body.installations.length > 0) {
      const xmtpIdsToVerify = body.installations.map((inst) => inst.identityId);
      const ownedIdentities = await prisma.deviceIdentity.findMany({
        where: {
          xmtpId: { in: xmtpIdsToVerify },
          // Same person == same identity id
          id: deviceIdentityForAuthenticatedUser.id,
        },
        select: { id: true, xmtpId: true },
      });

      if (ownedIdentities.length !== xmtpIdsToVerify.length) {
        req.log.warn(
          `Identity ${deviceIdentityForAuthenticatedUser.id} attempt to register with one or more unowned/unknown identities (by xmtpId).`,
        );
        res.status(403).json({
          error: "Forbidden: Identity access denied for one or more identities",
        });
        return;
      }

      xmtpIdToIdentityIdMap = new Map(
        ownedIdentities.map((di) => [di.xmtpId, di.id]),
      );
    }

    await prisma.$transaction(async (tx) => {
      // Update the device with the new push token
      await tx.device.update({
        where: {
          id: body.deviceId,
        },
        data: {
          pushToken: body.pushToken,
          pushTokenType: body.pushTokenType,
          apnsEnv: body.apnsEnv,
        },
      });

      // Find all existing identities on the device for logging
      const allExistingIdentitiesOnDevice =
        await tx.identitiesOnDevice.findMany({
          where: {
            deviceId: body.deviceId,
            xmtpInstallationId: { not: null },
          },
          select: { xmtpInstallationId: true, identityId: true },
        });

      const incomingInstallationIds = body.installations.map(
        (inst) => inst.xmtpInstallationId,
      );

      req.log.info(
        {
          deviceId: body.deviceId,
          existingInstallations: allExistingIdentitiesOnDevice.map(
            (i) => i.xmtpInstallationId,
          ),
          incomingInstallations: incomingInstallationIds,
        },
        "Registration update: comparing existing vs incoming installations",
      );

      // Upsert the new installations
      for (const installation of body.installations) {
        const resolvedIdentityId = xmtpIdToIdentityIdMap.get(
          installation.identityId,
        );
        if (!resolvedIdentityId) {
          // This should not happen due to pre-verification; skip defensively
          req.log.warn(
            {
              xmtpId: installation.identityId,
              deviceId: body.deviceId,
            },
            "Skipping upsert for installation due to unresolved identityId from xmtpId",
          );
          continue;
        }

        await tx.identitiesOnDevice.upsert({
          where: {
            deviceId_identityId: {
              deviceId: body.deviceId,
              identityId: resolvedIdentityId,
            },
          },
          create: {
            deviceId: body.deviceId,
            identityId: resolvedIdentityId,
            xmtpInstallationId: installation.xmtpInstallationId,
          },
          update: {
            xmtpInstallationId: installation.xmtpInstallationId,
          },
        });
      }
    });

    // Register the new installations with XMTP
    // Process registrations in parallel for better performance
    const registrationResults = await Promise.all(
      body.installations.map(async (installation) => {
        try {
          const response = await notificationClient.registerInstallation({
            installationId: installation.xmtpInstallationId,
            deliveryMechanism: {
              deliveryMechanismType: {
                case: "apnsDeviceToken",
                value: body.pushToken,
              },
            },
          });
          return {
            xmtpInstallationId: installation.xmtpInstallationId,
            validUntil: Number(response.validUntil),
            status: "success" as const,
          };
        } catch (regError) {
          req.log.error(
            { error: regError, installationData: installation },
            "Failed to register installation with XMTP server",
          );
          return {
            status: "error" as const,
          };
        }
      }),
    );

    const response: IRegisterInstallationResponse = registrationResults;

    const safeResponse = registerInstallationResponseSchema.safeParse(response);

    if (!safeResponse.success) {
      // Just log the error and don't return or throw because it's not a big deal
      req.log.error({ error: safeResponse.error }, "Response validation error");
    }

    res.status(201).json(response);
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    req.log.error({ error }, "Failed to register installation(s)");
    res.status(500).json({ error: "Failed to register installation(s)" });
  }
}

async function handleLegacyRegistration(args: {
  res: Response;
  body: ILegacyRegisterInstallationRequestBody;
}) {
  const { res, body } = args;

  try {
    const response = await notificationClient.registerInstallation({
      installationId: body.installationId,
      deliveryMechanism: body.deliveryMechanism,
    });

    res.status(201).json({
      installationId: response.installationId,
      validUntil: Number(response.validUntil),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    res.status(500).json({ error: "Failed to register installation" });
  }
}
