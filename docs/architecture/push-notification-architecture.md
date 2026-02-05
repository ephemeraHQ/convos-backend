# Push Notification System

## Overview

```mermaid
flowchart LR
    XMTP["XMTP Network"] -->|"1. New message"| Go["Go Notification Server"]
    Go -->|"2. HTTP Webhook"| Convos["Convos Backend"]
    Convos -->|"3. Push"| APNs["APNs / FCM"]
    APNs -->|"4. Deliver"| Device["Mobile Device"]
```

## Webhook Sequence

```mermaid
sequenceDiagram
    participant XMTP as XMTP Network
    participant Go as Go Notification Server
    participant Convos as Convos Backend
    participant Push as APNs / FCM
    participant Device as Mobile Device

    XMTP->>Go: New message on topic
    Go->>Go: Validate HMAC key
    Go->>Convos: POST /api/v2/notifications/xmtp/handle-notification
    Convos->>Convos: Lookup device by clientId
    Convos->>Convos: Generate JWT for NSE
    Convos->>Push: Send push notification
    Push->>Device: Deliver notification
    Device->>Device: Wake up, fetch full message
```

## Why Use the Go Notification Server?

The Go server (`xmtp/notifications-server`) is part of XMTP infrastructure. It listens directly to the XMTP network for new messages - something our TypeScript backend cannot do.

| Go Server | Convos Backend |
|-----------|----------------|
| Listens to XMTP network (gRPC) | Receives HTTP webhooks |
| Validates HMAC keys | Sends push notifications |
| Detects new messages on subscribed topics | Manages device registrations |
| Part of XMTP infrastructure | Our custom code |
