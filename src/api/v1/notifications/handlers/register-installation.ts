import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const installationItemSchema = z.object({
  identityId: z.string(),
  xmtpInstallationId: z.string(),
});

const registrationSchema = z.object({
  deviceId: z.string(),
  pushToken: z.string(),
  expoToken: z.string(),
  // List of installations to register
  // We will also check for any other identities on device that don't have any of those installations and delete them
  installations: z.array(installationItemSchema),
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

export type RegisterInstallationRequestBody = z.infer<
  typeof registrationSchema
>;

const notificationClient = createNotificationClient();

export async function registerInstallation(
  req: Request<unknown, unknown, RegisterInstallationRequestBody>,
  res: Response,
) {
  try {
    const authenticatedXmtpId = req.app.locals.xmtpId;

    const validatedData = registrationSchema.parse(req.body);

    // Make sure the authenticated user has a DeviceIdentity
    const deviceIdentityForAuthenticatedUser =
      await prisma.deviceIdentity.findFirst({
        where: { xmtpId: authenticatedXmtpId },
        select: { userId: true },
      });

    if (!deviceIdentityForAuthenticatedUser) {
      res
        .status(403)
        .json({ error: "Forbidden: Authenticated user not found" });
      return;
    }

    // Make sure the device belongs to the authenticated user
    const deviceOwnerCheck = await prisma.device.findUnique({
      where: { id: validatedData.deviceId },
      select: { userId: true },
    });

    if (
      !deviceOwnerCheck ||
      deviceOwnerCheck.userId !== deviceIdentityForAuthenticatedUser.userId
    ) {
      req.log.warn(
        `User ${deviceIdentityForAuthenticatedUser.userId} attempt to register for unowned/unknown device ${validatedData.deviceId}`,
      );
      res.status(403).json({ error: "Forbidden: Device access denied" });
      return;
    }

    // Make sure all the identities being registered belong to the authenticated user
    if (validatedData.installations.length > 0) {
      const identityIdsToVerify = validatedData.installations.map(
        (inst) => inst.identityId,
      );
      const ownedIdentities = await prisma.deviceIdentity.findMany({
        where: {
          id: { in: identityIdsToVerify },
          userId: deviceIdentityForAuthenticatedUser.userId,
        },
        select: { id: true },
      });

      if (ownedIdentities.length !== identityIdsToVerify.length) {
        req.log.warn(
          `User ${deviceIdentityForAuthenticatedUser.userId} attempt to register with one or more unowned/unknown identities.`,
        );
        res.status(403).json({
          error: "Forbidden: Identity access denied for one or more identities",
        });
        return;
      }
    }

    const identitiesOnDeviceToRemoveFromDb = await prisma.$transaction(
      async (tx) => {
        // Update the device with the new push token and expo token
        await tx.device.update({
          where: {
            id: validatedData.deviceId,
          },
          data: {
            expoToken: validatedData.expoToken,
            pushToken: validatedData.pushToken,
          },
        });

        // Find all the identities on the device that are not in the new installations
        const staleIdentitiesOnDevice = await tx.identitiesOnDevice.findMany({
          where: {
            deviceId: validatedData.deviceId,
            AND: [
              {
                xmtpInstallationId: {
                  not: {
                    in: validatedData.installations.map(
                      (inst) => inst.xmtpInstallationId,
                    ),
                  },
                },
              },
              {
                xmtpInstallationId: {
                  not: null,
                },
              },
            ],
          },
          select: { xmtpInstallationId: true, identityId: true },
        });

        // If there are any identities on the device that are not in the new installations, delete them because they are stale
        if (staleIdentitiesOnDevice.length > 0) {
          const staleIdentityIds = staleIdentitiesOnDevice.map(
            (r) => r.identityId,
          );
          await tx.identitiesOnDevice.deleteMany({
            where: {
              deviceId: validatedData.deviceId,
              identityId: { in: staleIdentityIds },
            },
          });
        }

        // Upsert the new installations
        for (const installation of validatedData.installations) {
          await tx.identitiesOnDevice.upsert({
            where: {
              deviceId_identityId: {
                deviceId: validatedData.deviceId,
                identityId: installation.identityId,
              },
            },
            create: {
              deviceId: validatedData.deviceId,
              identityId: installation.identityId,
              xmtpInstallationId: installation.xmtpInstallationId,
            },
            update: {
              xmtpInstallationId: installation.xmtpInstallationId,
            },
          });
        }

        return staleIdentitiesOnDevice;
      },
    );

    // Delete the stale installations from XMTP
    // Process deletions in parallel for better performance
    await Promise.all(
      identitiesOnDeviceToRemoveFromDb
        .filter((installation) => installation.xmtpInstallationId)
        .map(async (removedInstallation) => {
          try {
            // TODO: Shouldn't happen later but added this until we put xmtpInstallationId as required in the DB
            if (!removedInstallation.xmtpInstallationId) {
              return;
            }
            await notificationClient.deleteInstallation({
              installationId: removedInstallation.xmtpInstallationId,
            });
            req.log.info(
              `Successfully deleted stale XMTP installation ${removedInstallation.xmtpInstallationId} for identity ${removedInstallation.identityId}`,
            );
          } catch (delError) {
            req.log.error(
              {
                error: delError,
                xmtpInstallationId: removedInstallation.xmtpInstallationId,
                identityId: removedInstallation.identityId,
              },
              "Failed to delete stale installation from XMTP server",
            );
          }
        }),
    );

    // Register the new installations with XMTP
    // Process registrations in parallel for better performance
    const registrationResults = await Promise.all(
      validatedData.installations.map(async (installation) => {
        try {
          const response = await notificationClient.registerInstallation({
            installationId: installation.xmtpInstallationId,
            deliveryMechanism: {
              deliveryMechanismType: {
                case: "customToken",
                value: validatedData.expoToken,
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
      res.status(400).json({ errors: error.errors });
      return;
    }
    req.log.error({ error }, "Failed to register installation(s)");
    res.status(500).json({ error: "Failed to register installation(s)" });
  }
}
