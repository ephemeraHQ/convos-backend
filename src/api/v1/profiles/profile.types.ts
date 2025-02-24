import type { Profile } from "@prisma/client";
import type { ProfileValidationErrorType } from "./handlers/validate-profile";

// Define validation response type
export type ProfileValidationResponse = {
  success: boolean;
  errors?: {
    name?: { type: ProfileValidationErrorType; message: string };
    username?: { type: ProfileValidationErrorType; message: string };
    description?: { type: ProfileValidationErrorType; message: string };
    avatar?: { type: ProfileValidationErrorType; message: string };
  };
  message?: string;
};

export type ProfileValidationRequest = Partial<
  Pick<Profile, "name" | "username" | "description" | "avatar">
>;
