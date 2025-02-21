import type { Profile } from "@prisma/client";

// Define validation response type
export type ProfileValidationResponse = {
  success: boolean;
  errors?: {
    username?: string;
    description?: string;
    name?: string;
    avatar?: string;
  };
  message?: string;
};

export type ProfileValidationRequest = Partial<
  Pick<Profile, "name" | "username" | "description" | "avatar">
>;
