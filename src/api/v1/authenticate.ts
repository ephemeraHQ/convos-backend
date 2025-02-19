import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import { Router, type Request, type Response } from "express";
// import { credential } from "firebase-admin";
// import { initializeApp, type ServiceAccount } from "firebase-admin/app";
// import { getAppCheck } from "firebase-admin/app-check";
import * as jose from "jose";
import { hexToBytes, type Hex } from "viem";

const authenticateRouter = Router();

const xmtpEnv = (process.env.XMTP_ENV || "dev") as XmtpEnv;

export type AuthenticateResponse = {
  token: string;
};

// POST /authenticate - Create a JWT token from headers
authenticateRouter.post("/", async (req: Request, res: Response) => {
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not set");
    }

    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    }

    const appCheckToken = req.header("X-Firebase-AppCheck");
    const xmtpInstallationId = req.header("X-XMTP-InstallationId");
    const xmtpId = req.header("X-XMTP-InboxId");
    const xmtpSignature = req.header("X-XMTP-Signature");

    // make sure all headers are present
    if (!appCheckToken || !xmtpInstallationId || !xmtpId || !xmtpSignature) {
      throw new Error("Missing headers");
    }

    // convert installation ID to bytes
    const installationId = hexToBytes(`0x${xmtpInstallationId}`);

    // validate installation ID
    const isValidInstallation = await Client.isInstallationAuthorized(
      xmtpId,
      installationId,
      {
        env: xmtpEnv,
      },
    );

    if (!isValidInstallation) {
      throw new Error("Invalid installation ID");
    }

    // verify signature
    const signature = hexToBytes(xmtpSignature as Hex);
    const isValidSignature = Client.verifySignedWithPublicKey(
      appCheckToken,
      signature,
      installationId,
    );

    if (!isValidSignature) {
      throw new Error("Invalid signature");
    }

    // TODO: re-enable when AppCheck works in bun
    // const serviceAccount = JSON.parse(
    //   process.env.FIREBASE_SERVICE_ACCOUNT,
    // ) as ServiceAccount;
    // const app = initializeApp({
    //   credential: credential.cert(serviceAccount),
    // });
    // await getAppCheck(app).verifyToken(appCheckToken);

    // Create JWT token
    const jwt = await new jose.SignJWT({
      inboxId: xmtpId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    res.json({ token: jwt });
  } catch {
    res.status(500).json({ error: "Failed to create authentication token" });
  }
});

export default authenticateRouter;
