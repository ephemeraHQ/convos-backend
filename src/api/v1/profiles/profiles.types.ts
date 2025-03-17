import type { DeviceIdentity, Profile } from "@prisma/client";

export type GetProfileRequestParams = {
  xmtpId: string;
};

export type ProfileRequestResult = Pick<
  Profile,
  "id" | "name" | "username" | "description" | "avatar"
> &
  Pick<DeviceIdentity, "xmtpId" | "privyAddress">;

// Public profile data exposed via API
export type PublicProfileResult = Pick<
  Profile,
  "name" | "username" | "description" | "avatar"
> &
  Pick<DeviceIdentity, "xmtpId">;
