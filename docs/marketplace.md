# Microsoft Marketplace transactable SaaS integration

How the Property Podcast app fulfils a Microsoft Marketplace SaaS subscription,
what has to be configured in Azure, and how to test it.

**No secret appears in this file, and none is committed to the repository.**

---

## What was built

| Piece | Where |
|---|---|
| Landing page | `marketplace.html` / `marketplace.js` / `marketplace.css`, served at `/marketplace` |
| Buyer sign-in | Vendored `vendor/msal-browser-5.19.0.min.js` (Authorization Code + PKCE) |
| Public config endpoint | `GET /api/marketplace/config` |
| Resolve endpoint | `POST /api/marketplace/resolve` |
| Webhook | `POST /api/marketplace/webhook` |
| Fulfillment client | `api/src/lib/fulfillmentClient.js` |
| Webhook JWT validation | `api/src/lib/webhookAuth.js` |
| Persistence | `api/src/lib/subscriptionStore.js` (Azure Table Storage) |

### Live URLs

```
https://blue-mushroom-0206a3d10.7.azurestaticapps.net/marketplace
https://blue-mushroom-0206a3d10.7.azurestaticapps.net/api/marketplace/webhook
https://blue-mushroom-0206a3d10.7.azurestaticapps.net/api/marketplace/resolve
```

---

## Auto activation changes the flow — read this first

The `Property Podcast Standard` plan has **auto activation on**. Microsoft's
[lifecycle documentation](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/pc-saas-fulfillment-life-cycle)
states plainly what that changes:

| Step | Manual activation | **Auto activation** |
|---|---|---|
| PendingFulfillmentStart state | Yes | No |
| Landing page redirect | Yes | **No** |
| Resolve API required | Yes | **No** |
| Activate API required | Yes | **No** |
| Billing starts | After activation | Immediately at purchase |

Consequences for this implementation:

1. **We never call Activate.** Microsoft activates at purchase. A redundant
   Activate call would act on an already-`Subscribed` subscription. This is
   asserted by the test *"Subscribe does not acknowledge an operation"*.
2. **The webhook is the authoritative path**, not the landing page. Microsoft
   sends full subscription details on the `Subscribe` notification.
3. **The landing page is still required and still implemented**, because
   Microsoft calls it with a `token` whenever a customer picks
   **Manage SaaS experience** on an active subscription, and Partner Center
   requires the URL regardless.

---

## Configuration

Set these as **Static Web App → Settings → Environment variables** (they become
the Functions app settings). Values shown are placeholders.

```
MARKETPLACE_TENANT_ID=<tenant-id>
MARKETPLACE_FULFILLMENT_CLIENT_ID=<client-id>
MARKETPLACE_FULFILLMENT_CLIENT_SECRET=<secret>
MARKETPLACE_BUYER_CLIENT_ID=<client-id>
MARKETPLACE_SAAS_RESOURCE_ID=20e940b3-4c77-4b0b-9a53-9e16a1b010a7
MARKETPLACE_STORAGE_CONNECTION=<storage-account-connection-string>
MARKETPLACE_TABLE_NAME=MarketplaceSubscriptions
```

| Setting | Purpose | Required |
|---|---|---|
| `MARKETPLACE_TENANT_ID` | Dezrez tenant. Used for the token endpoint and as the expected `tid` on webhook JWTs. | Yes |
| `MARKETPLACE_FULFILLMENT_CLIENT_ID` | **Fulfillment** app. Used for client credentials and as the expected `aud` on webhook JWTs. | Yes |
| `MARKETPLACE_FULFILLMENT_CLIENT_SECRET` | Secret for that app. Server-side only. | Yes |
| `MARKETPLACE_BUYER_CLIENT_ID` | **Buyer** app. Public; served to the browser by `/api/marketplace/config`. | For sign-in |
| `MARKETPLACE_SAAS_RESOURCE_ID` | Marketplace SaaS API. Defaults correctly if unset. | No |
| `MARKETPLACE_STORAGE_CONNECTION` | Table Storage connection string. | Yes |
| `MARKETPLACE_TABLE_NAME` | Table name. Defaults to `MarketplaceSubscriptions`. | No |

If a required value is missing, every endpoint returns **503** with
`{"error":"not_configured"}` and logs the missing **names only**. It never
degrades to in-memory state — losing subscription state would be a billing bug,
not an inconvenience.

### The two app registrations

**`Property Podcast Marketplace` (buyer-facing).** Multitenant, admits work/school
*and* personal Microsoft accounts, SPA redirect URI
`https://blue-mushroom-0206a3d10.7.azurestaticapps.net/marketplace`. Used only to
sign the buyer in on the landing page. It has no secret, holds no privileges over
the Fulfillment APIs, and its client ID is public by design.

**`Property Podcast Marketplace Fulfillment` (server-to-server).** Single tenant,
no redirect URI, holds the client secret. Used for client-credentials tokens
against the Marketplace SaaS resource. Microsoft recommends single tenant for
this, which matches how it is configured.

> The service principal for `20e940b3-4c77-4b0b-9a53-9e16a1b010a7` must exist in
> the tenant. Per Microsoft, create it with:
> `az ad sp create --id 20e940b3-4c77-4b0b-9a53-9e16a1b010a7`

### Partner Center mapping

| Partner Center field | Value |
|---|---|
| Landing page URL | `https://blue-mushroom-0206a3d10.7.azurestaticapps.net/marketplace` |
| Connection webhook | `https://blue-mushroom-0206a3d10.7.azurestaticapps.net/api/marketplace/webhook` |
| Microsoft Entra tenant ID | Dezrez tenant → `MARKETPLACE_TENANT_ID` |
| Microsoft Entra application ID | **Fulfillment** app → `MARKETPLACE_FULFILLMENT_CLIENT_ID` |

The tenant and application IDs in Partner Center **must** match the values used
to mint tokens, and they are also the `tid` and `aud` we require on inbound
webhook JWTs. A mismatch shows up as `auth_tenant_invalid` or
`auth_audience_invalid`.

---

## Azure prerequisites

1. **A Storage Account** in the same subscription. Copy a connection string from
   *Access keys* into `MARKETPLACE_STORAGE_CONNECTION`. The table is created on
   first use; no manual setup needed.
2. **Application Insights** on the Static Web App. Managed Functions produce no
   queryable logs without it, so webhook troubleshooting is effectively blind.
   Strongly recommended before going to preview.

> Static Web Apps **managed** functions have no managed identity and no Key Vault
> references, so the client secret has to live as an application setting. It is
> encrypted at rest and never exposed to the browser, but if Key Vault
> indirection is a requirement, that means moving to a bring-your-own Functions
> app.

---

## Local development

```bash
cd api
cp local.settings.json.example local.settings.json   # then fill it in
npm install
```

`api/local.settings.json` is git-ignored. Run the whole thing with the Static Web
Apps CLI (`npm i -g @azure/static-web-apps-cli`):

```bash
swa start . --api-location api
```

Run the tests without any Azure resources at all:

```bash
npm test
```

---

## How the flow works

### Purchase (auto activation)

```
Customer buys  ->  Microsoft activates immediately
               ->  POST /api/marketplace/webhook   action=Subscribe
                     validate JWT (signature, aud, tid, appid/azp)
                     GET subscription from Microsoft   (authoritative)
                     claim idempotency marker
                     persist
                   200
```

### Manage an existing subscription

```
Customer picks "Manage SaaS experience"
  -> GET /marketplace?token=<purchase token>
       token stashed, stripped from the URL
       buyer signs in (MSAL, multitenant)
  -> POST /api/marketplace/resolve  { token }
       Resolve against Microsoft, persist, return a safe projection
  -> "Microsoft Marketplace subscription active"
```

### Lifecycle events

| Action | Handling | Acknowledged? |
|---|---|---|
| `Subscribe` | Persist as active | No — notify-only |
| `Unsubscribe` | Persist as unsubscribed | No — notify-only |
| `Suspend` | Persist as suspended | No — notify-only |
| `Renew` | Refresh persisted state | No — notify-only |
| `Reinstate` | Persist, then PATCH `Success` | Yes |
| `ChangePlan` | Persist new plan, then PATCH `Success` | Yes |
| `ChangeQuantity` | Persist new quantity, then PATCH `Success` | Yes |
| anything else | Logged and acknowledged with 200 | No |

`ChangePlan` and `ChangeQuantity` cannot occur with a single flat-rate plan —
there is nothing to change to, and the plan is not per-seat. They are implemented
anyway because Microsoft can send them if a second plan is ever added, and
because an unhandled one would otherwise be retried 500 times over eight hours.

### Entitlement

The podcast itself stays free and public — it is not locked behind payment. The
entitlement model is deliberately the smallest that demonstrates the chain:

```
purchase -> webhook received -> subscription persisted -> active state shown at /marketplace
```

---

## Security properties

| Requirement | How |
|---|---|
| No secret in the browser bundle | The secret is only read in `api/`; the page receives only the public buyer client ID |
| No secret in git history | `api/local.settings.json` is ignored; only `.example` is committed |
| No token in logs | `logging.js` allow-lists log fields and redacts by name; asserted by tests |
| Webhook actually validated | Signature via tenant JWKS plus `aud`, `tid`, `appid`/`azp` and issuer; presence of a header is never sufficient |
| Payload not trusted | Every event is re-read from Microsoft with our own credentials before persisting |
| No cross-customer access | The API accepts a Microsoft-issued purchase token, never a caller-supplied subscription ID |
| Errors disclose nothing | Provider bodies are never echoed; responses carry a fixed code |
| HTTPS | Static Web Apps is HTTPS-only |

The test *"the webhook body is not trusted over Microsoft authoritative state"*
proves the last point: a forged body claiming a premium plan loses to what
Microsoft actually reports.

---

## Testing a Marketplace preview purchase

1. Keep the offer in **preview** with a limited audience.
2. Microsoft recommends a **zero price**, or cancelling test purchases within 24
   hours, to avoid real billing.
3. Buy the offer as a preview audience member.
4. Expect a `Subscribe` webhook almost immediately (auto activation). Confirm in
   Application Insights and in the storage table.
5. Open **Manage SaaS experience** to exercise the landing page and Resolve.
6. Cancel from the Microsoft 365 admin centre and confirm an `Unsubscribe`
   webhook flips the stored status.

Test purchases arrive with `isTest: true`, which the landing page displays.

---

## Webhook troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 auth_header_missing` | Something stripped the Authorization header. Do not put tokens in the webhook URL. |
| `401 auth_audience_invalid` | Partner Center's application ID differs from `MARKETPLACE_FULFILLMENT_CLIENT_ID`. |
| `401 auth_tenant_invalid` | Partner Center's tenant ID differs from `MARKETPLACE_TENANT_ID`. |
| `401 auth_appid_invalid` | Caller is not the Marketplace SaaS resource. |
| `401 auth_token_expired` | Clock skew beyond 60s, or a replayed old call. |
| `503 not_configured` | An environment variable is missing — the log names which. |
| `502 token_rejected` | The fulfillment client secret is wrong or expired. |
| `500 processing_failed` | Upstream or storage failure. Microsoft will retry; the event was not claimed, so the retry is processed properly. |
| `200 {"status":"duplicate"}` | Normal. Microsoft redelivered something already processed. |

Every log line is structured JSON with a `message` like
`marketplace.webhook.processed`, so Application Insights can be filtered by it.

---

## Known limits

- **`ChangePlan`/`ChangeQuantity` are untested against real traffic**, since a
  one-plan flat-rate offer cannot produce them.
- **No rate limiting** on `/api/marketplace/resolve`. Possession of a valid,
  24-hour, Microsoft-issued purchase token is the authorisation; a caller without
  one learns nothing. Front Door or APIM would be the place to add throttling.
- **Buyer sign-in is not linked to an account**, because the product has no user
  accounts. It satisfies Microsoft's SSO requirement on the landing page and
  identifies the buyer; it grants nothing, which is why the buyer's token is not
  sent to or trusted by the backend.
