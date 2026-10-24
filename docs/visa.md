# Visa Intelligent Commerce rail (issue #39)

Status: **code written, never run against a live Visa sandbox.** We have no Visa
credentials yet (issue #2). Until they exist, `internal.visaRail.pay` returns
`{ok:false, error:"Visa sandbox not configured"}` and the demo uses the mock rail.

Code: [`dashboard/convex/visaRail.ts`](../dashboard/convex/visaRail.ts), a `"use node"` Convex
internal action.

## What we found

Sources:
- Visa Intelligent Commerce overview: https://developer.visa.com/capabilities/visa-intelligent-commerce/overview
  (this page blocks automated fetches, so we read it through search snippets.)
- **Visa's official sample code, github.com/visa/ai** (commit `1c544e5`, 2026-09-30):
  `packages/api-client` (VIC client, X-Pay token, MLE) and `apps/shared-utils/payload-builders`.
  This is the main source for anything marked *verified* below.
- VIC docs index served by Visa's docs MCP: https://sandbox.mcp.visa.com/mcp/doc/llms.txt
- Auth guides: [X-Pay token](https://developer.visa.com/pages/working-with-visa-apis/x-pay-token),
  [Two-way SSL](https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl),
  [MLE / encryption](https://developer.visa.com/pages/encryption_guide)

How VIC works:
1. **Tokenize the card (VTS).** The family's card gets an agent-specific token
   from Visa Token Service. That gives a `vProvisionedTokenId`, which VIC calls
   `tokenId` / `enrollmentReferenceId`. It's a one-time setup step, done outside
   the call. The VTS host is different: `https://cert.api.visa.com` per the sample.
2. **Enroll the card in VIC.** `POST /vacp/v1/cards` (one time; the card is linked to a `consumerId`).
3. **Create a purchase instruction.** `POST /vacp/v1/instructions`. This sets a mandate with a
   `declineThreshold` amount, a preferred merchant and an expiry, plus
   `assuranceData` (proof the cardholder authorized it).
4. **Get payment credentials.** `POST /vacp/v1/instructions/{instructionId}/credentials`.
   Visa checks the transaction against the instruction and returns one-time
   credentials (token PAN, expiry, cryptogram). The agent then pays the merchant with them.
5. **Send the outcome signal.** `POST /vacp/v1/instructions/{instructionId}/confirmations`.

Also available: `PUT /vacp/v1/instructions/{id}` (update) and `PUT /vacp/v1/instructions/{id}/cancel`.

How auth works for the VIC REST APIs (verified in the sample code and llms.txt):
- **X-Pay-Token, not two-way TLS.** Every request goes to `https://sandbox.api.visa.com/vacp/v1/...?apikey=<API key>`
  with the header `x-pay-token: xv2:<unix-ts>:<hex HMAC-SHA256(sharedSecret, ts + resourcePath + query + body)>`.
  Here `resourcePath` drops the `/vacp/` context prefix (for example `v1/instructions`), and `query` includes `apikey=...`.
- **Message Level Encryption (MLE) is mandatory.** The body is `{"encData": "<compact JWE>"}`,
  encrypted with `RSA-OAEP-256` / `A128GCM`, using Visa's MLE server cert and `kid` set to your key ID.
  Requests also send a `keyId` header. Responses come back in the same envelope, and you decrypt them with your MLE private key.
- Request bodies include `client: {externalClientId, externalAppId}`. Visa issues both at VIC onboarding.
- Two-way SSL (client cert, key, user ID and password) is used by **VDP** APIs such as Hello World.
  The VIC client in Visa's sample doesn't use it. Our code supports it as an
  optional extra, in case the sandbox project has it turned on.

So the answer to the SPEC §21 question "does the sandbox need a client certificate?" is **probably not
for VIC.** It needs an API key, a shared secret and an MLE key pair. We still use
`"use node"`, because we need `node:crypto` for the RSA-OAEP JWE and `node:https` for optional mTLS.

## What `pay` does

`internal.visaRail.pay({orderId, amountCents, idempotencyKey})`:
1. Returns `{ok:false, error:"Visa sandbox not configured"}` if any required env var is missing.
2. Creates a purchase instruction. The mandate caps it at exactly the order total, for
   merchant "Walmart", expiring in 1 hour.
3. Retrieves payment credentials for that amount. We have no real merchant checkout, so the
   credentials are **dropped immediately**: they are never logged, returned or stored.
4. Sends a confirmation signal, which is best-effort.
5. Returns `{ok:true, tokenRef:"vic:<instructionId>:<transactionReferenceId>"}`. The backend stores only this
   in `paymentTokenRef`.

The whole call is limited to 8 s. Errors name the step and the HTTP status only (for example
`"Visa payment credentials failed (HTTP 401)"`). No response body or exception text is surfaced.
`clientReferenceId`, `transactionReferenceId` and `mandateId` are derived from `idempotencyKey`
(a sha256 formatted as a UUID), so retries line up in Visa's logs. **Double-pay protection is the backend's job.**
It checks the order's idempotency key before calling `pay`.

## Verified vs assumed

| Item | Status |
|---|---|
| Endpoint paths and methods for instructions, credentials and confirmations | Verified (sample code and llms.txt) |
| X-Pay-Token format, resource-path rule, `?apikey=` | Verified (sample `x-pay-token.ts`) |
| MLE algorithms, `encData` envelope, `keyId` header | Verified (sample `mle.ts`) |
| Request field names (`clientReferenceId`, `tokenId`, `mandates`, `transactionData`, `confirmationData`, `client`) | Verified (sample payload builders) |
| Sandbox base URL `https://sandbox.api.visa.com` | Verified (sample `.env.example`) |
| Our hand-written JWE (node:crypto) is accepted by Visa | **Assumed.** It round-trips locally, but Visa's sample uses `node-jose` and we didn't test interop |
| Amounts are decimal dollar strings (`"21.45"`) | **Assumed.** The sample uses `"800.00"` and `"710"` |
| Static `DEVICE` `assuranceData` is accepted in sandbox | **Assumed.** Production needs a Visa Passkey (FIDO) assertion, which a phone-only caller can't give |
| A successful credentials response contains `transactionCredentials` | **Assumed.** Based on the sample's TypeScript type |
| Sending an `APPROVED` confirmation with no real acquirer is acceptable in sandbox | **Assumed** |
| Two-way SSL plus Basic auth on VIC | **Assumed unnecessary.** Supported only as an option |
| Grocery MCC `5411`, server-style `appInstance` | **Assumed** |

## Env vars (Convex deployment env, never in the repo)

Convex env values are strings and can't point at files, so **PEMs are passed as contents**. You can
paste them multi-line, or on one line with `\n` escapes (the code turns `\n` back into newlines).

| Var | Required | Meaning (Visa sample name) |
|---|---|---|
| `PAYMENT_RAIL` | n/a | `visa` turns this rail on. The default, `mock`, never calls Visa |
| `VISA_API_KEY` | yes | VIC API key (`VISA_VIC_API_KEY`) |
| `VISA_SHARED_SECRET` | yes | VIC API key shared secret (`VISA_VIC_API_KEY_SS`) |
| `VISA_MLE_SERVER_CERT_PEM` | yes | Visa's MLE server certificate, PEM (`VISA_MLE_SERVER_CERT`) |
| `VISA_MLE_PRIVATE_KEY_PEM` | yes | Our MLE client private key, PEM (`VISA_MLE_PRIVATE_KEY`) |
| `VISA_MLE_KEY_ID` | yes | MLE key ID (`VISA_KEY_ID`) |
| `VISA_EXTERNAL_CLIENT_ID` | yes | From VIC onboarding |
| `VISA_EXTERNAL_APP_ID` | yes | From VIC onboarding |
| `VISA_CONSUMER_ID` | yes | The consumer ID the demo card was enrolled under |
| `VISA_TOKEN_ID` | yes | VTS `vProvisionedTokenId` for the demo card (`VISA_ENROLLMENT_REFERENCE_ID`) |
| `VISA_API_BASE_URL` | no | Defaults to `https://sandbox.api.visa.com` |
| `VISA_CERT_PEM`, `VISA_KEY_PEM` | no | Two-way SSL client cert and key, only if the project requires it |
| `VISA_USER_ID`, `VISA_PASSWORD` | no | Basic auth that goes with two-way SSL |

Example: `npx convex env set VISA_MLE_SERVER_CERT_PEM "$(awk 'NF{printf "%s\\n",$0}' mle_server_cert.pem)"`

## How it is switched on

The backend's payment step reads Convex env `PAYMENT_RAIL`. If it is `"mock"` or unset, the mock rail
is used. If it is `"visa"`, the backend calls
`ctx.runAction(internal.visaRail.pay, {orderId, amountCents, idempotencyKey})`. On `{ok:true}` it stores
`tokenRef` as `paymentTokenRef` and marks the order paid. On `{ok:false}` it sets the order to `failed` and records a
`payment_failed` alert (the contract's `/agent/order` → `failed`). The `PAYMENT_RAIL` switch belongs to
the backend workstream (`payments.ts`), not this file.

## Blocked on sponsor access

- VIC sandbox onboarding (issue #2). That gives the API key, shared secret, `externalClientId` and `externalAppId`.
- The MLE key pair. You make a CSR with the key ID as UID and download Visa's server cert from the VDP project.
- A VTS-tokenized test card and a VIC enrollment (`/vacp/v1/cards`) to get `VISA_TOKEN_ID` and `VISA_CONSUMER_ID`.
  The sample says existing VTS clients set this up through their Visa rep, so this may need Visa staff at the event.
- Confirmation of the assumptions above (amount format, sandbox `assuranceData`, success response shape).

## Checklist for whoever gets sandbox credentials

1. **Create the VDP project with VIC enabled.** Note the API key and shared secret. Generate the MLE CSR, download
   Visa's MLE server cert and note the key ID. Get `externalClientId` and `externalAppId` from VIC onboarding.
2. **Prove auth first.** Clone github.com/visa/ai, fill in `apps/vic-api-examples/.env`, and run its
   `retrieve-credentials-confirmations` workflow. This also gives you a sandbox `tokenId` and `consumerId` to reuse.
3. **Set the Convex env vars** in the table above with `npx convex env set ...`, on the dev deployment only.
   Don't paste values into chat, commits or logs.
4. **Run one payment by hand:** `npx convex run visaRail:pay '{"orderId":"test","amountCents":2145,"idempotencyKey":"manual-1"}'`.
   If it fails, the error names the step and HTTP status. The usual culprits: X-Pay resource path, JWE
   interop (try swapping in `node-jose` if Visa rejects our JWE), amount format, or `assuranceData`.
5. **Set `PAYMENT_RAIL=visa`** and run Call 1 (test T1). Check the order is `paid` for 2145 cents with
   `paymentTokenRef` starting `vic:`. Then grep the Convex logs and DB for any 13–19-digit number to confirm no card data leaked.
   Update the Verified vs assumed table above.
