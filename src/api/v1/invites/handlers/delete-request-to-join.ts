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

    // Find the request to join with this request id / xmtp id
    const requestToJoin = await prisma.inviteCodeRequest.findUnique({
      where: { id: params.requestId, requester: { xmtpId } },
      include: {
        requester: true,
      },
    });
    if (!requestToJoin) {
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
        message: "Invalid request body",
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
