import type { NextFunction, Request, Response } from "express";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";

// TODO: configure firebase app
const _firebaseApp = initializeApp();

export const appCheck = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appCheckToken = req.header("X-Firebase-AppCheck");

  if (!appCheckToken) {
    res.status(401);
    next("Unauthorized");
    return;
  }

  try {
    await getAppCheck().verifyToken(appCheckToken);
    next();
  } catch (error) {
    console.error(error);
    res.status(401);
    next("Unauthorized");
  }
};
