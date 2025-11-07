import { Router } from "express";
import { getPresignedUrlHandler } from "./handlers/get-presigned-url";

export const attachmentsRouter = Router();

attachmentsRouter.get("/presigned", getPresignedUrlHandler);
