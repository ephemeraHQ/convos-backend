// TypeScript declaration merging to add types for Express res.locals
// This provides type safety when middleware sets values on res.locals
declare namespace Express {
  interface Locals {
    // api v2 auth middleware - only set when JWT auth is used (not AppCheck)
    deviceId?: string;
    jwtMetadata?: {
      notificationExtensionOnly?: boolean;
    };
  }
}
