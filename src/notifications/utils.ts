import { XMTP_NOTIFICATION_SECRET } from "@/config";

export function getHttpDeliveryNotificationAuthHeader() {
  return XMTP_NOTIFICATION_SECRET;
}
