import { makeBearerTokenAuth } from "@/middleware/bearerTokenAuth";

/**
 * Validates that the request has a valid DEV_API_TOKEN.
 * Used to protect dev-only endpoints from unauthorized access.
 */
export const devAuthMiddleware = makeBearerTokenAuth("DEV_API_TOKEN");
