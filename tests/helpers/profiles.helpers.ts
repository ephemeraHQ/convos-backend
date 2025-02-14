import type { Profile } from "@prisma/client";
import type { CreatedUser } from "@/api/v1/users";
import {
  TEST_USER_DATA,
  VALID_PROFILE_DATA,
} from "../fixtures/profiles.fixtures";

export async function createTestUser(): Promise<CreatedUser> {
  const response = await fetch("http://localhost:3004/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(TEST_USER_DATA),
  });
  const result = await response.json();
  return result as CreatedUser;
}

export async function createTestProfile(
  deviceIdentityId: string,
): Promise<Profile> {
  const response = await fetch(
    `http://localhost:3004/profiles/${deviceIdentityId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(VALID_PROFILE_DATA),
    },
  );
  const result = await response.json();
  return result as Profile;
}
