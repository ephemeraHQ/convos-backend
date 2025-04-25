import type { Request, Response } from "express";
import { turnkeyClient, turnkeyConfig } from "../config";
import type { GetSubOrgIdParams, GetSubOrgIdResponse } from "../types";

export async function getSubOrgId(
  req: Request<object, object, GetSubOrgIdParams>,
  res: Response,
) {
  try {
    const { filterType, filterValue } = req.body;

    const { organizationIds } = await turnkeyClient.getSubOrgIds({
      filterType,
      filterValue,
    });

    const response: GetSubOrgIdResponse = {
      organizationId: organizationIds[0] || turnkeyConfig.defaultOrganizationId,
    };

    return res.status(200).json(response);
  } catch (error: unknown) {
    console.error("Error getting sub org ID:", error);
    return res.status(500).json({ error: "Failed to get organization ID" });
  }
}
