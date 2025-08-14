import { type DeviceIdentity } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const querySchema = z.object({
  device_id: z.string().optional(),
});

type QueryParams = z.infer<typeof querySchema>;

export type ReturnedCurrentUser = {
  identities: Array<Pick<DeviceIdentity, "id" | "identityAddress" | "xmtpId">>;
};

export async function getCurrentUser(
  req: Request<unknown, unknown, unknown, QueryParams>,
  res: Response,
) {
  try {
    const { xmtpId } = req.app.locals;
    const { device_id: deviceId } = querySchema.parse(req.query);

    // Find the authenticated identity
    const authIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      select: { id: true },
    });

    if (!authIdentity) {
      res.status(404).json({ error: "Identity not found" });
      return;
    }

    const uniqueIdentities = new Map<
      string,
      Pick<DeviceIdentity, "id" | "identityAddress" | "xmtpId">
    >();

    // List identities across devices for this identity's devices
    const devices = await prisma.device.findMany({
      where: {
        identities: {
          some: {
            identityId: authIdentity.id,
          },
        },
        ...(deviceId && { id: deviceId }),
      },
      select: {
        identities: {
          select: {
            identity: {
              select: { id: true, identityAddress: true, xmtpId: true },
            },
          },
        },
      },
    });

    devices.forEach((d) => {
      d.identities.forEach(({ identity }) => {
        uniqueIdentities.set(identity.id, {
          id: identity.id,
          identityAddress: identity.identityAddress,
          xmtpId: identity.xmtpId,
        });
      });
    });

    const returnedUser: ReturnedCurrentUser = {
      identities: Array.from(uniqueIdentities.values()),
    };

    res.json(returnedUser);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: "Invalid query parameters", details: err.errors });
      return;
    }
    req.log.error({ error: err }, "Error fetching current user");
    res.status(500).json({ error: "Failed to fetch user" });
  }
}
