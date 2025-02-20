import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { ReturnedCurrentUser } from "../users.types";

const prisma = new PrismaClient();

export async function getCurrentUser(req: Request, res: Response) {
  try {
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

    const returnedUser: ReturnedCurrentUser = {
      id: user.id,
      identities: user.devices.flatMap((device) =>
        device.identities.map(({ identity }) => ({
          id: identity.id,
          privyAddress: identity.privyAddress,
          xmtpId: identity.xmtpId,
        })),
      ),
    };

    res.json(returnedUser);
  } catch (err) {
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
}
