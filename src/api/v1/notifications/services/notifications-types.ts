export type NotificationType = "Protocol" | "InviteJoinRequest";

export type ProtocolNotificationData = {
  contentTopic: string;
  messageType: string;
  encryptedMessage: string;
  timestamp: string;
};

export type InviteJoinRequestNotificationData = {
  inviteId: string;
};

// Mapping from NotificationType to its payload shape
export type NotificationTypeToData = {
  Protocol: ProtocolNotificationData;
  InviteJoinRequest: InviteJoinRequestNotificationData;
};

type NotificationPayloadBase<T extends NotificationType> = {
  notificationType: T;
  inboxId: string;
  data: NotificationTypeToData[T];
};

// Discriminated union over notificationType
export type NotificationPayload = {
  [K in NotificationType]: NotificationPayloadBase<K>;
}[NotificationType];

// Helper generic when the type is known at the call-site
export type NotificationPayloadFor<T extends NotificationType> =
  NotificationPayloadBase<T>;
