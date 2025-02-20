import type { DeviceIdentity } from "@prisma/client";

export type ReturnedCurrentUser = {
  id: string;
  identities: Array<Pick<DeviceIdentity, "id" | "privyAddress" | "xmtpId">>;
};

export type CreatedReturnedUser = {
  id: string;
  privyUserId: string;
  device: {
    id: string;
    os: DeviceOS;
    name: string | null;
  };
  identity: {
    id: string;
    privyAddress: string;
    xmtpId: string | null;
  };
  profile: {
    id: string;
    name: string;
    description: string | null;
  } | null;
};
