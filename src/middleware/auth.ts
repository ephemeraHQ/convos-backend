import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import type { NextFunction, Request, Response } from "express";
import { credential } from "firebase-admin";
import { initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { hexToBytes, type Hex } from "viem";

if (process.env.NODE_ENV !== "test") {
  const serviceAccount = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    process.env.FIREBASE_SERVICE_ACCOUNT!,
  ) as ServiceAccount;

  initializeApp({
    credential: credential.cert(serviceAccount),
  });
}

const xmtpEnv = (process.env.XMTP_ENV || "dev") as XmtpEnv;

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appCheckToken = req.header("X-Firebase-AppCheck");
  const xmtpInstallationId = req.header("X-XMTP-InstallationId");
  const xmtpInboxId = req.header("X-XMTP-InboxId");
  const xmtpSignature = req.header("X-XMTP-Signature");

  // make sure all headers are present
  if (!appCheckToken || !xmtpInstallationId || !xmtpInboxId || !xmtpSignature) {
    res.status(401).send();
    return;
  }

  try {
    // convert installation ID to bytes
    const installationId = hexToBytes(`0x${xmtpInstallationId}`);

    // validate installation ID
    const isValidInstallation = await Client.isInstallationAuthorized(
      xmtpInboxId,
      installationId,
      {
        env: xmtpEnv,
      },
    );

    if (!isValidInstallation) {
      res.status(401).send();
      return;
    }

    // verify signature
    const signature = hexToBytes(xmtpSignature as Hex);
    const isValidSignature = Client.verifySignedWithPublicKey(
      appCheckToken,
      signature,
      installationId,
    );

    if (!isValidSignature) {
      res.status(401).send();
      return;
    }

    await getAppCheck().verifyToken(appCheckToken);
    next();
  } catch {
    res.status(500).send();
  }
};
