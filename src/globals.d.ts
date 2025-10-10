// TypeScript declaration merging to add types for Express res.locals
// This provides type safety when middleware sets values on res.locals
declare namespace Express {
  interface Locals {
    // API v1 auth middleware
    xmtpId: string;
    xmtpInstallationId: string;

    // api v2 auth middleware
    deviceId: string;
    jwtMetadata?: {
      notificationExtensionOnly?: boolean;
    };
  }
}
