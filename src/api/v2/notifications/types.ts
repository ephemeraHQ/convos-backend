export type NotificationType =
  | "Protocol"
  | "InviteJoinRequest"
  | "CreditsRefilled";

export type ProtocolNotificationData = {
  contentTopic: string;
  messageType: string;
  encryptedMessage?: string;
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

export type CreditsRefilledNotificationData = {
  creditsAdded: number;
  newBalance: string;       // bigint serialized
  refilledAt: string;       // ISO UTC
  nextRefreshAt: string;    // ISO UTC, start of next UTC day
};

// Mapping from NotificationType to its payload shape
export type NotificationTypeToData = {
  Protocol: ProtocolNotificationData;
  InviteJoinRequest: InviteJoinRequestNotificationData;
  CreditsRefilled: CreditsRefilledNotificationData;
};

// Base notification payload with XOR semantics for v1/v2 transition
// Ensures exactly one of inboxId (v1) or clientId (v2) is present
type NotificationPayloadBase<T extends NotificationType> = {
  notificationType: T;
  notificationData: NotificationTypeToData[T];
} & (
  | { inboxId: string; clientId?: never }
  | { clientId: string; inboxId?: never }
);

// Discriminated union over notificationType
export type NotificationPayload = {
  [K in NotificationType]: NotificationPayloadBase<K>;
}[NotificationType];

// Helper generic when the type is known at the call-site
export type NotificationPayloadFor<T extends NotificationType> =
  NotificationPayloadBase<T>;

export type NotificationPayloadWithJWTToken = NotificationPayload & {
  apiJWT: string;
};

// v2 notification types (structurally compatible with v2 branch of NotificationPayloadWithJWTToken)
export type V2NotificationPayload = {
  clientId: string;
  apiJWT: string;
  notificationType: "Protocol";
  notificationData: ProtocolNotificationData;
};

// Backend-originated push — no user JWT, no inboxId. Added so push services
// (APNS/FCM) can accept payloads that don't carry an apiJWT.
export type CreditsRefilledPayload = {
  clientId: string;                            // deviceId, for v2-shaped routing
  notificationType: "CreditsRefilled";
  notificationData: CreditsRefilledNotificationData;
};

// Union type for push services that can handle both v1 and v2
export type AnyNotificationPayloadWithJWT =
  | NotificationPayloadWithJWTToken
  | V2NotificationPayload
  | CreditsRefilledPayload;
