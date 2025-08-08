import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const requestToJoinSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export type RequestToJoinRequestBody = z.infer<typeof requestToJoinSchema>;

export type RequestToJoinResponse = {
  id: string;
  inviteId: string;
  createdAt: string;
};

export type InviteRequestNotificationPayload = {
  id: string;
  createdAt: string;
  updatedAt: string;
  requester: {
    id: string;
    xmtpId: string;
    profile: {
      name: string | null;
      username: string | null;
      description: string | null;
      avatar: string | null;
    } | null;
  };
  inviteCode: {
    id: string;
    name: string | null;
    description: string | null;
    groupId: string;
  };
  autoApprove: boolean;
};

type Logger = {
  info: (data: unknown, message?: string) => void;
  warn: (data: unknown, message?: string) => void;
  error: (data: unknown, message?: string) => void;
};

async function sendInviteRequestNotification(args: {
  payload: InviteRequestNotificationPayload;
  logger: Logger;
}) {
  const { payload, logger } = args;

  // Only attempt local simulator push when on macOS and required env vars are set
  const simId = process.env.IOS_SIMULATOR_ID;
  const bundleId = process.env.IOS_BUNDLE_ID;

  if (process.platform !== "darwin" || !simId || !bundleId) {
    logger.info(
      { configured: Boolean(simId && bundleId), platform: process.platform },
      "Skipping simulator push (not configured or not macOS)",
    );
    return;
  }

  // Construct a simple APNS payload expected by simctl
  const title = `${payload.requester.profile?.name || payload.requester.xmtpId} requested to join`;
  const body = payload.inviteCode.name
    ? `Group: ${payload.inviteCode.name}`
    : `Group ID: ${payload.inviteCode.groupId}`;

  const apnsPayload = {
    aps: {
      alert: {
        title,
        body,
      },
      sound: "default",
      "mutable-content": 1,
    },
    type: "invite_request",
    invite: payload,
  };

  // Write payload to a temporary file
  const tmpBase = await mkdtemp(join(tmpdir(), "convos-invite-"));
  const payloadPath = join(tmpBase, `invite-${payload.id}.apns.json`);
  console.log({ payloadPath });
  await writeFile(payloadPath, JSON.stringify(apnsPayload, null, 2), "utf8");

  try {
    const { stdout, stderr, exitCode } = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      execFile(
        "xcrun",
        ["simctl", "push", simId, bundleId, payloadPath],
        (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: error ? 1 : 0,
          });
        },
      );
    });

    if (exitCode === 0) {
      logger.info({ stdout }, "Simulator push succeeded");
    } else {
      logger.warn({ stderr }, "Simulator push failed");
    }
  } catch (error) {
    logger.error({ error }, "Error running simctl push");
  } finally {
    // Best-effort cleanup
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

export async function requestToJoin(
  req: Request<unknown, unknown, RequestToJoinRequestBody>,
  res: Response,
) {
  try {
    const body = await requestToJoinSchema.parseAsync(req.body);
    const { xmtpId } = req.app.locals;

    // Find the requester's identity
    const requesterIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      include: { profile: true },
    });

    if (!requesterIdentity) {
      res.status(404).json({
        success: false,
        message: "Identity not found",
      });
      return;
    }

    // Find the invite code
    const inviteCode = await prisma.inviteCode.findUnique({
      where: { id: body.inviteId },
      include: {
        createdBy: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!inviteCode) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    // Check if invite is active
    if (inviteCode.status !== "ACTIVE") {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    // Check if invite is expired
    if (inviteCode.expiresAt && inviteCode.expiresAt < new Date()) {
      res.status(400).json({
        success: false,
        message: "Invite has expired",
      });
      return;
    }

    // Check if user already has a pending/accepted request
    const existingRequest = await prisma.inviteCodeRequest.findUnique({
      where: {
        inviteCodeId_requesterId: {
          inviteCodeId: body.inviteId,
          requesterId: requesterIdentity.id,
        },
      },
    });

    if (existingRequest) {
      res.status(409).json({
        success: false,
        message: `You already have a request for this group`,
      });
      return;
    }

    // Create the request and return populated relations
    const requestToJoin = await prisma.inviteCodeRequest.create({
      data: {
        inviteCodeId: body.inviteId,
        requesterId: requesterIdentity.id,
      },
      include: {
        requester: {
          include: { profile: true },
        },
        inviteCode: {
          select: {
            id: true,
            name: true,
            description: true,
            groupId: true,
            autoApprove: true,
          },
        },
      },
    });

    const payload: InviteRequestNotificationPayload = {
      id: requestToJoin.id,
      createdAt: requestToJoin.createdAt.toISOString(),
      updatedAt: requestToJoin.updatedAt.toISOString(),
      requester: {
        id: requestToJoin.requester.id,
        xmtpId: requestToJoin.requester.xmtpId,
        profile: requestToJoin.requester.profile
          ? {
              name: requestToJoin.requester.profile.name,
              username: requestToJoin.requester.profile.username,
              description: requestToJoin.requester.profile.description,
              avatar: requestToJoin.requester.profile.avatar,
            }
          : null,
      },
      inviteCode: {
        id: requestToJoin.inviteCode.id,
        name: requestToJoin.inviteCode.name,
        description: requestToJoin.inviteCode.description,
        groupId: requestToJoin.inviteCode.groupId,
      },
      autoApprove: requestToJoin.inviteCode.autoApprove,
    };

    sendInviteRequestNotification({ payload, logger: req.log });

    const response: RequestToJoinResponse = {
      id: requestToJoin.id,
      inviteId: requestToJoin.inviteCodeId,
      createdAt: requestToJoin.createdAt.toISOString(),
    };

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid request body",
        errors: error.errors,
      });
      return;
    }

    req.log.error({ error }, "Error creating join request");
    res.status(500).json({
      success: false,
      message: "Failed to create join request",
    });
  }
}

