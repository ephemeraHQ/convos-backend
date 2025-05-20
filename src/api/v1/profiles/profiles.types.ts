import type { DeviceIdentity, Profile } from "@prisma/client";

export type GetProfileRequestParams = {
  xmtpId: string;
};

export type ProfileRequestResult = Pick<
  Profile,
  "id" | "name" | "username" | "description" | "avatar"
> &
  Pick<DeviceIdentity, "xmtpId" | "turnkeyAddress">;

// Public profile data exposed via API
export type PublicProfileResult = Pick<
  Profile,
  "name" | "username" | "description" | "avatar"
> &
  Pick<DeviceIdentity, "xmtpId" | "turnkeyAddress">;

// Batch profile request body
export type BatchGetProfilesRequestBody = {
  xmtpIds: string[];
};

// Batch profiles response format
export type BatchProfilesResponse = {
  profiles: Record<string, ProfileRequestResult>;
};
