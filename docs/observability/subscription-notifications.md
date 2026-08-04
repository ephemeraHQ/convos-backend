# Subscription provider-notification observability (Apple SSN / Play RTDN)

Why this exists: the prod app record had **no** App Store Server Notification
URL from launch until 2026-07-29 (~11:15 CEST) — prod received zero SSNs ever,
and nothing noticed. This doc defines the stable log events the handlers emit,
the DB audit surface for dropped deliveries, and the Datadog monitors that make
a silent feed impossible to miss again.

## Stable log events (log-explorer / monitor contract — do not rename)

Emitted by `src/api/v2/subscriptions/handlers/apple-ssn.ts` as the pino `msg`:

| Event                       | Level     | Meaning                                                                                                                                                                                                               |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription.ssn.received` | info      | A signature-verified Apple delivery arrived. Fires after the outer JWS verifies, so unverifiable garbage on this unauthenticated endpoint doesn't count as feed traffic. `received = applied + dropped-after-verify`. |
| `subscription.ssn.applied`  | info      | A state change was applied (or replayed — see the `replayed` field).                                                                                                                                                  |
| `subscription.ssn.dropped`  | warn/info | The delivery produced no state change. Always carries `reason`, plus `notificationType` / `notificationSubtype` / `notificationUUID` / `originalTransactionId` where they exist at the drop point.                    |

The 500 path (`Failed to apply Apple S2S notification`) is neither applied nor
dropped — Apple retries it.

Fields on `applied`: `notificationType`, `notificationSubtype`,
`notificationUUID`, `originalTransactionId`, `transactionId`, `environment`
(Sandbox/Production — the daily sandbox canary shows up here), `accountId`,
`subscriptionStatus`, `replayed`.

`dropped` reasons:

| `reason`                         | HTTP | Persisted? | Notes                                                                                                                                                   |
| -------------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_body`                   | 400  | no         | Not SSN-shaped; likely scanners.                                                                                                                        |
| `invalid_notification_signature` | 400  | no         | Outer JWS failed verification. Unverified payloads are never persisted.                                                                                 |
| `missing_notification_uuid`      | 400  | no         | Verified but malformed.                                                                                                                                 |
| `no_transaction`                 | 200  | no         | Summary / externalPurchaseToken / appData branches.                                                                                                     |
| `invalid_transaction_signature`  | 400  | no         | Inner transaction JWS failed.                                                                                                                           |
| `missing_transaction_ids`        | 400  | no         | Verified transaction without OTX/transactionId.                                                                                                         |
| `no_actionable_update`           | 200  | no         | TEST / CONSUMPTION_REQUEST / unmapped types.                                                                                                            |
| `unknown_subscription`           | 200  | **yes**    | No Subscription row matched the OTX. **The orphan-detection signal** — persisted as a drop receipt (below), `receiptRecorded` false on provider replay. |

Google Play mirrors the drop persistence via the shared `applyNotification`:
`play.rtdn.applied` / `play.rtdn.unknown_subscription — acking` (now with
`receiptRecorded`).

## Log-explorer filters (Datadog, paste-ready)

Base (Louis's saved view "Convos Prod Apple SSN" — all feed traffic):

```
env:convos-otr-prod service:(api OR notifications) @pathname:/api/v2/webhooks/apple/ssn
```

Per event (full-text match works regardless of the pino `msg` → `@msg`/`@message`
attribute mapping; `@msg:"…"` is the precise form if the forwarder maps it):

```
env:convos-otr-prod @pathname:/api/v2/webhooks/apple/ssn "subscription.ssn.received"
env:convos-otr-prod @pathname:/api/v2/webhooks/apple/ssn "subscription.ssn.applied"
env:convos-otr-prod @pathname:/api/v2/webhooks/apple/ssn "subscription.ssn.dropped"
```

Drill-downs: facet `@reason` on the dropped stream
(`… "subscription.ssn.dropped" @reason:unknown_subscription`), `@environment`
on applied to split the sandbox canary from real production renewals.

## DB audit surface — unmatched drop receipts

`BillingReceipt.subscriptionId` is now nullable: NULL rows are verified
provider notifications that matched no Subscription
(migration `20260729130500_billing_receipt_unmatched_drops`). They carry the
provider-side identity in `providerSubscriptionId` (Apple
`originalTransactionId` / Google `purchaseToken`), are idempotent on the
existing `idempotencyKey` unique (`apple-ssn:{notificationUUID}` /
`play-rtdn:{messageId}`), and keep the raw JWS in `signedPayload` for replay.

Adoption: if the provider retries the same notification after `/verify` has
created the Subscription row, the apply path claims the drop receipt (sets its
`subscriptionId`) and applies the state change — so a receipt stays
`subscriptionId IS NULL` only while the subscription is still unknown.

```sql
-- SSNs arriving for subscriptions we don't know (newest first)
SELECT "receivedAt", "provider", "providerSubscriptionId",
       "notificationType", "notificationSubtype", "externalNotificationId"
FROM "BillingReceipt"
WHERE "subscriptionId" IS NULL
ORDER BY "receivedAt" DESC;

-- Feed liveness from the DB (complement to the log monitor):
-- any Apple SSN receipt (matched or dropped) in the last 26h?
SELECT count(*) FROM "BillingReceipt"
WHERE "idempotencyKey" LIKE 'apple-ssn:%'
  AND "receivedAt" > now() - interval '26 hours';
```

## Monitors (Datadog)

Datadog monitors are Terraform-managed in the `infrastructure` repo
(`plans/convos/monitors.tf`) — add the snippets below there. The `@msg` caveat
from that file applies: pino emits `msg`; confirm the forwarder maps it to
`@msg` (or swap for the quoted full-text form) by checking one real
`subscription.ssn.applied` log line first.

How to create by hand instead: Datadog → Monitors → New Monitor → Logs → paste
the query → set the threshold/window → add the Slack handle.

### 1. Silent Apple SSN feed (the one that would have caught the zero-SSN era)

Invariant: at least one `subscription.ssn.applied` every 26h. Valid from day
one — Louis's sandbox subscription renews roughly daily against prod (via the
JWS environment fallback), so a healthy feed always produces ≥1 applied/day
even with zero real customers. First production renewal wave lands Aug 8.

- Query: `env:convos-otr-prod service:(api OR notifications) @msg:"subscription.ssn.applied"`
- Condition: count `< 1` over the last `26h` ⇒ alert. (If the UI rejects a
  custom 26h window, fall back to `1d` — expect occasional flap around the
  canary's renewal time.)
- A below-threshold log monitor evaluates an empty result as 0, so it fires on
  total silence; `notify_no_data` stays off.

```hcl
resource "datadog_monitor" "backend_apple_ssn_feed_silent" {
  name    = "convos-backend Apple SSN feed silent — no subscription.ssn.applied in 26h (${terraform.workspace})"
  type    = "log alert"
  message = <<-MSG
    No `subscription.ssn.applied` event in 26 hours. The App Store Server
    Notification feed is silent: URL deregistered/wrong in App Store Connect,
    JWS verification broken, or the handler is failing before apply.
    A daily sandbox renewal canary guarantees >=1 applied/day when healthy.

    Check: [SSN traffic](https://app.datadoghq.com/logs?query=env%3Aconvos-otr-prod%20%40pathname%3A%2Fapi%2Fv2%2Fwebhooks%2Fapple%2Fssn)
    — deliveries arriving but dropping? Look at `subscription.ssn.dropped`
    `@reason`. No deliveries at all? Check App Store Connect notification URL.

    ${local.backend_notify}
  MSG

  # If the forwarder maps pino msg to @message, replace @msg accordingly.
  query = "logs(\"env:convos-otr-prod service:(api OR notifications) @msg:\\\"subscription.ssn.applied\\\"\").rollup(\"count\").last(\"26h\") < 1"

  monitor_thresholds {
    critical = 1
  }

  include_tags   = true
  notify_no_data = false
  priority       = 1
}
```

### 2. Spike of dropped SSNs

Baseline is ~zero. Any sustained `subscription.ssn.dropped` volume means
deliveries are arriving and not landing — `@reason:unknown_subscription` in
particular is the orphaned-subscription signal (row owned by a dead sibling
account, or verify never ran).

- Query: `env:convos-otr-prod service:(api OR notifications) @msg:"subscription.ssn.dropped"`
- Condition: count `> 5` over the last `1h` ⇒ alert, warn at `> 1`.

```hcl
resource "datadog_monitor" "backend_apple_ssn_dropped_spike" {
  name    = "convos-backend subscription.ssn.dropped spike (${terraform.workspace})"
  type    = "log alert"
  message = <<-MSG
    Apple SSN deliveries are arriving but not applying. Facet `@reason`:
    `unknown_subscription` = notifications for subscriptions we have no row
    for (orphaned sub / verify never ran) — cross-check the DB drop receipts:
    `SELECT * FROM "BillingReceipt" WHERE "subscriptionId" IS NULL ORDER BY "receivedAt" DESC;`
    Signature reasons = verifier/root-cert trouble.

    ${local.backend_notify}
  MSG

  query = "logs(\"env:convos-otr-prod service:(api OR notifications) @msg:\\\"subscription.ssn.dropped\\\"\").rollup(\"count\").last(\"1h\") > 5"

  monitor_thresholds {
    warning  = 1
    critical = 5
  }

  include_tags   = true
  notify_no_data = false
  priority       = 2
}
```

### 3. Related (suggested): verify account-mismatch

`subscription.verify.account_mismatch`
(`src/api/v2/accounts/handlers/subscription-verify.ts`) is today only a warn
log, and it is the primary detection signal for orphaned subscriptions (it
names `existingAccountId`). Same shape as monitor 2:
`env:convos-otr-prod @msg:"subscription.verify.account_mismatch"`, count `> 0`
over `1h` ⇒ warn.
