import { type DeviceIdentity } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const querySchema = z.object({
  device_id: z.string().optional(),
});

type QueryParams = z.infer<typeof querySchema>;

export type ReturnedCurrentUser = {
  id: string;
  identities: Array<Pick<DeviceIdentity, "id" | "privyAddress" | "xmtpId">>;
};

export async function getCurrentUser(
  req: Request<unknown, unknown, unknown, QueryParams>,
  res: Response,
) {
  try {
    const { device_id: deviceId } = querySchema.parse(req.query);

    const user = await prisma.user.findFirst({
      where: {
        DeviceIdentity: {
          some: {
            xmtpId: req.app.locals.xmtpId,
          },
        },
      },
      select: {
        id: true,
        devices: {
          where: deviceId ? { id: deviceId } : undefined,
          select: {
            identities: {
              select: {
                identity: {
                  select: {
                    id: true,
                    privyAddress: true,
                    xmtpId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const uniqueIdentities = new Map<
      string,
      Pick<DeviceIdentity, "id" | "privyAddress" | "xmtpId">
    >();

    user.devices.forEach((device) => {
      device.identities.forEach(({ identity }) => {
        uniqueIdentities.set(identity.id, {
          id: identity.id,
          privyAddress: identity.privyAddress,
          xmtpId: identity.xmtpId,
        });
      });
    });

    const returnedUser: ReturnedCurrentUser = {
      id: user.id,
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
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
}
