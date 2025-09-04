import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const deleteRequestToJoinParams = z.object({
  requestId: z.string().min(1, "Request ID is required"),
});

export type DeleteRequestToJoinRequestParams = z.infer<
  typeof deleteRequestToJoinParams
>;

export type DeleteRequestToJoinResponse = {
  id: string;
  deleted: boolean;
};

export async function deleteRequestToJoin(req: Request, res: Response) {
  try {
    const params = await deleteRequestToJoinParams.parseAsync(req.params);
    const { xmtpId } = res.locals;

    // Find the authenticated user's identity (by xmtpId)
    const authenticatedIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
    });

    if (!authenticatedIdentity) {
      res.status(404).json({
        success: false,
        message: "Identity not found",
      });
      return;
    }

    // Load the join request with related entities to check authorization
    const requestToJoin = await prisma.inviteCodeRequest.findUnique({
      where: { id: params.requestId },
      include: {
        requester: true,
        inviteCode: {
          include: {
            createdBy: true,
            notificationTargets: {
              include: {
                deviceIdentity: true,
              },
            },
          },
        },
      },
    });
    if (!requestToJoin) {
      res.status(404).json({
        success: false,
        message: "Request to join not found",
      });
      return;
    }

    // Authorization: requester OR invite creator OR any notification target can delete
    const isRequester = requestToJoin.requester.xmtpId === xmtpId;
    const isCreator = requestToJoin.inviteCode.createdBy.xmtpId === xmtpId;
    const isNotificationTarget =
      requestToJoin.inviteCode.notificationTargets.some(
        (target) => target.deviceIdentity.xmtpId === xmtpId,
      );

    if (!isRequester && !isCreator && !isNotificationTarget) {
      // Conceal existence if unauthorized
      res.status(404).json({
        success: false,
        message: "Request to join not found",
      });
      return;
    }

    await prisma.inviteCodeRequest.delete({ where: { id: params.requestId } });

    const response: DeleteRequestToJoinResponse = {
      id: params.requestId,
      deleted: true,
    };

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid request params",
        errors: error.errors,
      });
      return;
    }

    req.log.error({ error }, "Error deleting join request");
    res.status(500).json({
      success: false,
      message: "Failed to delete join request",
    });
  }
}
