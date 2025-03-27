export function getHttpDeliveryNotificationAuthHeader() {
  if (!process.env.XMTP_NOTIFICATION_SECRET) {
    throw new Error("XMTP_NOTIFICATION_SECRET is not set");
  }
  return `Authorization:Bearer ${process.env.XMTP_NOTIFICATION_SECRET}`;
}
