import { Router } from "express";
import { getConversationsMetadataHandler } from "@/api/v1/metadata/handlers/get-conversations-metadata.handlers";
import { getConversationMetadataHandler } from "./handlers/get-conversation-metadata.handler";
import { upsertConversationMetadataHandler } from "./handlers/upsert-conversation-metadata.handler";

const metadataRouter = Router();

// GET /metadata/conversation/:deviceIdentityId/:conversationId - Get conversation metadata by device identity and conversation ID
metadataRouter.get(
  "/conversation/:deviceIdentityId/:conversationId",
  getConversationMetadataHandler,
);

// GET /metadata/conversation/:deviceIdentityId?conversationIds=id1,id2 - Get all conversation metadata by device identity and conversation IDs
metadataRouter.get(
  "/conversation/:deviceIdentityId",
  getConversationsMetadataHandler,
);

// POST /metadata/conversation - Upsert conversation metadata
metadataRouter.post("/conversation", upsertConversationMetadataHandler);

export default metadataRouter;
