import { credential } from "firebase-admin";
import {
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { AppError } from "@/utils/errors";
import logger from "./logger";

let cachedFirebaseApp: App | undefined;

const getFirebaseApp = () => {
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
    credential: credential.cert(serviceAccount),
  });

  return cachedFirebaseApp;
};

/**
 * Verify a Firebase App Check token using the shared Firebase app instance.
 */
export const verifyAppCheckToken = async (token: string) => {
  const app = getFirebaseApp();
  const appCheck = await getAppCheck(app).verifyToken(token);
  logger.info(`App Check token verified for app ${appCheck.appId}`);
};

/**
 * Generate a Firebase App Check token using the shared Firebase app instance.
 */
export const generateAppCheckToken = async () => {
  if (!process.env.FIREBASE_BACKEND_APP_ID) {
    throw new AppError(500, "FIREBASE_BACKEND_APP_ID is not set");
  }
  const app = getFirebaseApp();
  const appCheckToken = await getAppCheck(app).createToken(
    process.env.FIREBASE_BACKEND_APP_ID,
  );
  return appCheckToken.token;
};
