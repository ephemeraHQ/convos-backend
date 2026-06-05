# Subscription SKU deploy script

One YAML file is the source of truth for Convos's subscription product catalog
on Apple App Store Connect **and** Google Play Console. Run `pnpm sku:diff` to
see what would change; `pnpm sku:apply` to reconcile.

## Catalog

`config/subscriptions.catalog.yaml` — one entry per `(tier, period)` product.
Schema is validated by zod at load (see `scripts/sku/catalog.ts`):

- `productId` must match the runtime regex in
  `src/subscriptions/product-mapping.ts` (`app.convos.subs.<tier>.<period>`)
  AND agree with the declared `tier` / `period`.
- `localizations` must include `en-US`.
- `pricing` must include `USD`.
- Pricing is in **minor units** (cents). `USD: 999` = $9.99.
- `google.billingPeriod` is ISO-8601 (e.g. `P1M`, `P1Y`).

## CLI

```sh
pnpm sku:diff                  # default: --all --dry-run
pnpm sku:apply                 # default: --all --apply
pnpm tsx scripts/sku/apply.ts --apple --product app.convos.subs.builder.monthly
pnpm tsx scripts/sku/apply.ts --apply --allow-create
```

Flags:

| Flag                             | Effect                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--all` / `--apple` / `--google` | Which stores to touch (default `--all`)                                                                           |
| `--dry-run` / `--apply`          | Default is `--dry-run`                                                                                            |
| `--allow-create`                 | Required to create brand-new Apple subscriptions. New Apple subs must go through App Review before they activate. |
| `--product <id>`                 | Restrict to one product                                                                                           |
| `--json`                         | Emit machine-readable diff                                                                                        |
| `--catalog <path>`               | Override catalog path                                                                                             |

The script is idempotent: it fetches current store state, diffs against the
catalog, applies only the deltas, and re-diffs after apply to confirm.

## Credentials

The script reuses runtime env vars but the underlying API roles must be
**write-capable**:

### Apple

Sign-in JWT for the App Store Connect REST API. Either elevate the runtime
key to **App Manager** role, or provision a separate deploy-only key:

```env
APPLE_CONNECT_API_KEY_ID=<10-char key id>
APPLE_CONNECT_API_ISSUER_ID=<UUID>
APPLE_CONNECT_API_SIGNING_KEY=<full .p8 PEM including BEGIN/END lines>
```

If the `APPLE_CONNECT_API_*` vars are unset the script falls back to the
runtime `APPLE_API_*` triple — fine when the runtime key has been elevated.
`APPLE_BUNDLE_ID` is reused.

### Google

Service-account JSON with the Play Console role **"Manage orders and
subscriptions"** (or a custom permission set including subscription product
write). Either elevate the runtime service account or provision a separate
one:

```env
GOOGLE_PLAY_DEPLOY_SERVICE_ACCOUNT_JSON=<single-line JSON keyfile>
```

If unset, falls back to `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
`GOOGLE_PLAY_PACKAGE_NAME` is reused.

## Apple App Review caveat

Apple won't activate a brand-new auto-renewable subscription until it's
submitted with a binary build and goes through App Review. The script
refuses to create new Apple subs unless you pass `--allow-create` in
addition to `--apply`. After the create succeeds, the subscription's `state`
will be `WAITING_FOR_REVIEW`; finish the submission in App Store Connect.

Once a subscription exists, pricing changes and localization updates apply
immediately without review.

## Out of scope today

- Free-trial introductory offers (Apple `introductoryOffer`; Google
  base-plan free-trial offer).
- Promotional offers.
- Family sharing toggles, grace period, tax category overrides.
- Adding/removing locales beyond what's in the catalog (drift-tolerant:
  remote-only locales are left alone).
- Currency↔region mappings beyond USD/EUR/GBP — extend
  `currencyToRegion` (Google) and `currencyToTerritory` (Apple) when adding
  pricing.
