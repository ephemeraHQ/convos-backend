import type { Request, Response } from "express";
import type { CreateSubOrgParams, CreateSubOrgResponse } from "../types";
import { createSubOrgDirect } from "../utils/turnkey-helpers";

export async function createSubOrg(
  req: Request<object, object, CreateSubOrgParams>,
  res: Response,
) {
  try {
    const { passkey, oauth } = req.body;

    // Either passkey or oauth must be provided
    if (!passkey && !oauth) {
      return res.status(400).json({
        error: "Either passkey or oauth parameters must be provided",
      });
    }

    const result = await createSubOrgDirect({ passkey, oauth });

    const response: CreateSubOrgResponse = {
      subOrganizationId: result.subOrganizationId,
    };

    return res.status(201).json(response);
  } catch (error: unknown) {
    console.error("Error creating sub org:", error);
    return res.status(500).json({ error: "Failed to create sub organization" });
  }
}
