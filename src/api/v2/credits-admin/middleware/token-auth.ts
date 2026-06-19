import { makeBearerTokenAuth } from "@/middleware/bearerTokenAuth";

/**
 * Authorization gate for every credits-admin API route. Bound to a DEDICATED
 * secret (not the shared DEV_API_TOKEN) so the dev/invite token can never mint
 * credits. This is the hard gate; it works with no CF Access perimeter.
 */
export const creditsAdminTokenAuth = makeBearerTokenAuth(
  "CREDITS_ADMIN_API_TOKEN",
);
