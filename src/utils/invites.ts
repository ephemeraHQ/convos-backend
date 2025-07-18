export const getInviteLink = (inviteId: string): string => {
  const baseUrl = process.env.WEBSITE_URL || "";
  return `${baseUrl}/join/${inviteId}`;
};
