import { XMTP_NOTIFICATION_SECRET } from "@/config";

export function getHttpDeliveryNotificationAuthHeader() {
  if (!XMTP_NOTIFICATION_SECRET) {
    throw new Error(
      "XMTP_NOTIFICATION_SECRET is not configured - webhook authentication cannot proceed",
    );
  }
  return XMTP_NOTIFICATION_SECRET;
}
