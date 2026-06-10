import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { AppError } from "@/utils/errors";
import logger from "./logger";

let cachedFirebaseApp: App | undefined;

export const getFirebaseApp = () => {
  if (cachedFirebaseApp) {
    return cachedFirebaseApp;
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new AppError(500, "FIREBASE_SERVICE_ACCOUNT is not set");
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT,
  ) as ServiceAccount;

  cachedFirebaseApp = initializeApp({
    credential: cert(serviceAccount),
  });

  return cachedFirebaseApp;
};

/**
 * Verify a Firebase App Check token using the shared Firebase app instance.
 */
export const verifyAppCheckToken = async (token: string): Promise<string> => {
  const app = getFirebaseApp();
  const appCheck = await getAppCheck(app).verifyToken(token);
  logger.info(`App Check token verified for app ${appCheck.appId}`);
  return appCheck.appId;
};
