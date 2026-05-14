import { Router } from "express";
import {
  authOrAgentApiKeyAuth,
  optionalAuthOrAgentApiKeyAuth,
} from "@/middleware/agentAuth";
import { requireAccount } from "@/middleware/auth";
import { createHandler } from "./handlers/create";
import { deleteHandler } from "./handlers/delete";
import { detailHandler } from "./handlers/detail";
import { generationsGetHandler } from "./handlers/generations-get";
import { generationsPostHandler } from "./handlers/generations-post";
import { listHandler } from "./handlers/list";
import { patchHandler } from "./handlers/patch";
import { publishHandler } from "./handlers/publish";

export const agentTemplatesRouter = Router();

// Read endpoints (list, detail) are public. `optionalAuthOrAgentApiKeyAuth`
// still sets res.locals.accountId when credentials are provided, so a
// signed-in user can still see their own drafts; anonymous callers get
// the published-only view.
agentTemplatesRouter.get("/", optionalAuthOrAgentApiKeyAuth, listHandler);
agentTemplatesRouter.post(
  "/",
  authOrAgentApiKeyAuth,
  requireAccount,
  createHandler,
);

// Async generation surface — must be mounted before /:idOrHashedSlug so the
// wildcard doesn't capture "generations" as a slug-or-id. Both POST and GET
// are public: anonymous submissions default to the ADMIN owner; the GET
// status endpoint treats the generation ID itself as the capability token
// (anyone with the UUID can poll).
agentTemplatesRouter.post(
  "/generations",
  optionalAuthOrAgentApiKeyAuth,
  generationsPostHandler,
);
agentTemplatesRouter.get(
  "/generations/:generationId",
  optionalAuthOrAgentApiKeyAuth,
  generationsGetHandler,
);

agentTemplatesRouter.patch(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  patchHandler,
);
agentTemplatesRouter.delete(
  "/:id",
  authOrAgentApiKeyAuth,
  requireAccount,
  deleteHandler,
);
agentTemplatesRouter.post(
  "/:id/publish",
  authOrAgentApiKeyAuth,
  requireAccount,
  publishHandler,
);
agentTemplatesRouter.get(
  "/:idOrHashedSlug",
  optionalAuthOrAgentApiKeyAuth,
  detailHandler,
);
