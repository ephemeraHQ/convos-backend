import { Client, type XmtpEnv } from "@xmtp/node-sdk";
import { Router, type Request, type Response } from "express";
import * as jose from "jose";
import { hexToBytes, type Hex } from "viem";
// import { credential } from "firebase-admin";
// import { initializeApp, type ServiceAccount } from "firebase-admin/app";
// import { getAppCheck } from "firebase-admin/app-check";
import { AppError } from "@/utils/errors";
import { tryCatch } from "@/utils/try-catch";

const authenticateRouter = Router();

const xmtpEnv = (process.env.XMTP_ENV || "dev") as XmtpEnv;

export type JWTPayload = {
  inboxId: string;
  xmtpInstallationId: string;
};

export type AuthenticateResponse = {
  token: string;
};

// POST /authenticate - Create a JWT token from headers
authenticateRouter.post("/", async (req: Request, res: Response) => {
  // Check environment variables
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, "JWT_SECRET is not set");
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new AppError(500, "FIREBASE_SERVICE_ACCOUNT is not set");
  }

  const appCheckToken = req.header("X-Firebase-AppCheck");
  const xmtpInstallationId = req.header("X-XMTP-InstallationId");
  const xmtpId = req.header("X-XMTP-InboxId");
  const xmtpSignature = req.header("X-XMTP-Signature");

  // make sure all headers are present
  if (!appCheckToken || !xmtpInstallationId || !xmtpId || !xmtpSignature) {
    throw new AppError(400, "Missing headers");
  }

  // convert installation ID to bytes
  const installationId = hexToBytes(`0x${xmtpInstallationId}`);

  // validate installation ID
  const { data: isValidInstallation, error: installationError } =
    await tryCatch(
      Client.isInstallationAuthorized(xmtpId, installationId, {
        env: xmtpEnv,
      }),
    );

  if (installationError) {
    req.log.error(installationError);
    throw new AppError(
      400,
      "Failed to validate installation ID",
      installationError,
    );
  }

  if (!isValidInstallation) {
    throw new AppError(400, "Invalid installation ID");
  }

  // verify signature
  const signature = hexToBytes(xmtpSignature as Hex);
  const isValidSignature = Client.verifySignedWithPublicKey(
    appCheckToken,
    signature,
    installationId,
  );

  if (!isValidSignature) {
    throw new AppError(400, "Invalid signature");
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
  const { data: jwt, error: jwtError } = await tryCatch(
    new jose.SignJWT({
      inboxId: xmtpId,
      xmtpInstallationId,
    } satisfies JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)),
  );

  if (jwtError) {
    req.log.error(jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  res.json({ token: jwt });
});

export default authenticateRouter;
