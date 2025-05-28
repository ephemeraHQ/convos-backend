import { Router } from "express";
import { getConversationMetadataHandler } from "./handlers/get-conversation-metadata.handler";
import { upsertConversationMetadataHandler } from "./handlers/upsert-conversation-metadata.handler";

const metadataRouter = Router();

// GET /metadata/conversation/:deviceIdentityId/:conversationId - Get conversation metadata by device identity and conversation ID
metadataRouter.get(
  "/conversation/:deviceIdentityId/:conversationId",
  getConversationMetadataHandler,
);

// POST /metadata/conversation - Upsert conversation metadata
metadataRouter.post("/conversation", upsertConversationMetadataHandler);

export default metadataRouter;
