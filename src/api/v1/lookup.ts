import { Router, type Request, type Response } from "express";
import { createThirdwebClient } from "thirdweb";
import { getSocialProfiles } from "thirdweb/social";

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

      if (!process.env.THIRDWEB_SECRET_KEY) {
        throw new Error("THIRDWEB_SECRET_KEY is not set");
      }

      const client = createThirdwebClient({
        secretKey: process.env.THIRDWEB_SECRET_KEY,
      });

      const profiles = await getSocialProfiles({
        address,
        client,
      });

      res.json(profiles);
    } catch {
      res.status(500).json({ error: "Failed to lookup address" });
    }
  },
);

export default lookupRouter;
