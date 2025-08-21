export type NotificationType = "Protocol" | "InviteJoinRequest";

export type ProtocolNotificationData = {
  contentTopic: string;
  messageType: string;
  encryptedMessage: string;
  timestamp: string;
};

export type InviteJoinRequestNotificationData = {
  id: string;
  createdAt: string;
  updatedAt: string;
  requester: {
    id: string;
    xmtpId: string;
    profile: {
      name: string | null;
      username: string | null;
      description: string | null;
      avatar: string | null;
    } | null;
  };
  inviteCode: {
    id: string;
    name: string | null;
    description: string | null;
    groupId: string;
  };
  autoApprove: boolean;
};

// Mapping from NotificationType to its payload shape
export type NotificationTypeToData = {
  Protocol: ProtocolNotificationData;
  InviteJoinRequest: InviteJoinRequestNotificationData;
};

type NotificationPayloadBase<T extends NotificationType> = {
  inboxId: string;
  notificationType: T;
  notificationData: NotificationTypeToData[T];
};

// Discriminated union over notificationType
export type NotificationPayload = {
  [K in NotificationType]: NotificationPayloadBase<K>;
}[NotificationType];

// Helper generic when the type is known at the call-site
export type NotificationPayloadFor<T extends NotificationType> =
  NotificationPayloadBase<T>;

export type NotificationPayloadWithAppCheckToken = NotificationPayload & {
  appCheckToken: string;
};
