import { DeviceOS } from "@prisma/client";
import type { CreateProfileRequestBody } from "@/api/v1/profiles";
import type { CreateUserRequestBody } from "@/api/v1/users";

export const TEST_USER_DATA: CreateUserRequestBody = {
  privyUserId: "test-privy-user-id",
  device: {
    os: DeviceOS.ios,
    name: "iPhone 14",
  },
  identity: {
    privyAddress: "test-privy-address",
    xmtpId: "test-xmtp-id",
  },
};

export const VALID_PROFILE_DATA: CreateProfileRequestBody = {
  name: "Test Profile",
  description: "Test Description",
};

export const INVALID_PROFILE_DATA: CreateProfileRequestBody = {
  name: "ab", // too short
  description: "a".repeat(501), // too long
};
