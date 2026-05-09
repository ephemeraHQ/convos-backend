// TypeScript declaration merging to add types for Express res.locals
// This provides type safety when middleware sets values on res.locals
declare namespace Express {
  interface Locals {
    // Set by authMiddleware (JWT auth) or agentAuth (API key auth).
    accountId?: string;
    // Set by authMiddleware (JWT auth). Not set for appCheckOnlyMiddleware routes.
    deviceId?: string;
    jwtMetadata?: {
      notificationExtensionOnly?: boolean;
    };
  }
}
