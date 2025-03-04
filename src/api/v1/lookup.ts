import { Router, type Request, type Response } from "express";
import { getSocialProfilesForAddress } from "../../utils/thirdweb";

const lookupRouter = Router();

type GetAddressLookupRequestParams = {
  address: string;
};

// GET /lookup/address/:address - Lookup social profiles by address
lookupRouter.get(
  "/address/:address",
  async (req: Request<GetAddressLookupRequestParams>, res: Response) => {
    try {
      const { address } = req.params;

      const socialProfiles = await getSocialProfilesForAddress({
        address,
        sortByPriority: true,
      });

      res.json({ socialProfiles });
    } catch {
      res.status(500).json({
        error: "Failed to lookup address",
      });
    }
  },
);

export default lookupRouter;
