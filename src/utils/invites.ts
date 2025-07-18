export const getInviteLink = (inviteId: string): string => {
  return `${process.env.WEBSITE_URL}/join/${inviteId}`;
};
