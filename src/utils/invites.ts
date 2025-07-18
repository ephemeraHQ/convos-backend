import { AppError } from "./errors";

export const getInviteLink = (inviteId: string): string => {
  // Check environment variables
  if (!process.env.WEBSITE_URL) {
    throw new AppError(500, "WEBSITE_URL is not set");
  }
  return `${process.env.WEBSITE_URL}/join/${inviteId}`;
};
