"use node";

/**
 * Visa Intelligent Commerce (VIC) payment rail — SANDBOX ONLY, NOT YET RUN
 * AGAINST A LIVE SANDBOX.
 *
 * Exposes `internal.visaRail.pay`. The backend calls it from the payment step
 * of `place_order` when Convex env `PAYMENT_RAIL=visa` (default rail: "mock").
 * See docs/visa.md for the research, env vars and the credential checklist.
 *
 * What this does, per order:
 *   1. POST /vacp/v1/instructions               — purchase instruction (mandate
 *      capped at the order total, merchant = the order store, default "Walmart") for the household's
 *      agent token (`tokenId` = VTS vProvisionedTokenId, enrolled once).
 *   2. POST /vacp/v1/instructions/{id}/credentials — Visa checks the request
 *      against the instruction and releases one-time payment credentials.
 *      We have no real merchant checkout to hand them to, so they are
 *      DISCARDED immediately: never read field-by-field, logged, returned or
 *      stored.
 *   3. POST /vacp/v1/instructions/{id}/confirmations — report the outcome
 *      signal (best-effort; a failure here does not fail the order).
 *   Returns only a reference `vic:<instructionId>:<transactionReferenceId>`.
 *
 * Provenance legend used in comments below:
 *   [VERIFIED]  matches Visa's official sample code at github.com/visa/ai
 *               (packages/api-client, apps/shared-utils; commit 1c544e5,
 *               2026-09-30) and/or the VIC docs MCP llms.txt.
 *   [ASSUMED]   our best reading; needs confirming with real sandbox access.
 *
 * Security rules: no PAN / token PAN / CVV / cryptogram / credential ever goes
 * into a log line, an error string, a return value or the database. Errors
 * name the step and HTTP status only.
 */

import {
  X509Certificate,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  constants as cryptoConstants,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const NOT_CONFIGURED = "Visa sandbox not configured";
/** Whole pay() call must finish within this budget (spec: ~8s). */
const TOTAL_BUDGET_MS = 8_000;
/** [VERIFIED] sandbox host used by Visa's sample .env for VIC. */
const DEFAULT_BASE_URL = "https://sandbox.api.visa.com";
/** [ASSUMED] demo merchant; Call 1 orders are from "Walmart" (CONTRACT.md). */
const DEFAULT_MERCHANT_NAME = "Walmart";
const MERCHANT_URL = "https://www.walmart.com";

type PayResult = { ok: true; tokenRef: string } | { ok: false; error: string };

type VisaConfig = {
  baseUrl: string;
  apiKey: string;
  sharedSecret: string;
  mleServerCertPem: string;
  mlePrivateKeyPem: string;
  mleKeyId: string;
  externalClientId: string;
  externalAppId: string;
  consumerId: string;
  tokenId: string;
  /** Optional two-way SSL; VIC samples do not use it (see docs/visa.md). */
  tls: { certPem: string; keyPem: string } | null;
  basicAuth: { userId: string; password: string } | null;
};

/**
 * Convex env vars are single strings and cannot point at files, so PEMs are
 * passed as contents. Accept literal "\n" escapes so they can be set on one
 * line: `npx convex env set VISA_MLE_SERVER_CERT_PEM "$(awk ... cert.pem)"`.
 */
function pemFromEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
}

function loadConfig(): VisaConfig | null {
  const apiKey = env("VISA_API_KEY");
  const sharedSecret = env("VISA_SHARED_SECRET");
  const mleServerCertPem = pemFromEnv("VISA_MLE_SERVER_CERT_PEM");
  const mlePrivateKeyPem = pemFromEnv("VISA_MLE_PRIVATE_KEY_PEM");
  const mleKeyId = env("VISA_MLE_KEY_ID");
  const externalClientId = env("VISA_EXTERNAL_CLIENT_ID");
  const externalAppId = env("VISA_EXTERNAL_APP_ID");
  const consumerId = env("VISA_CONSUMER_ID");
  const tokenId = env("VISA_TOKEN_ID");
  if (
    !apiKey ||
    !sharedSecret ||
    !mleServerCertPem ||
    !mlePrivateKeyPem ||
    !mleKeyId ||
    !externalClientId ||
    !externalAppId ||
    !consumerId ||
    !tokenId
  ) {
    return null;
  }
  const certPem = pemFromEnv("VISA_CERT_PEM");
  const keyPem = pemFromEnv("VISA_KEY_PEM");
  const userId = env("VISA_USER_ID");
  const password = env("VISA_PASSWORD");
  return {
    baseUrl: (env("VISA_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    sharedSecret,
    mleServerCertPem,
    mlePrivateKeyPem,
    mleKeyId,
    externalClientId,
    externalAppId,
    consumerId,
    tokenId,
    tls: certPem && keyPem ? { certPem, keyPem } : null,
    basicAuth: userId && password ? { userId, password } : null,
  };
}

// ---------------------------------------------------------------------------
// X-Pay-Token  [VERIFIED against visa/ai packages/api-client/src/x-pay-token.ts]
// token = "xv2:" + ts + ":" + hex(HMAC-SHA256(sharedSecret,
//          ts + resourcePath + query + body))
// resourcePath = URL path with the leading "/vacp/" (or "/vdp/") context
// prefix removed, e.g. "/vacp/v1/instructions" -> "v1/instructions";
// query includes "apikey=<key>"; body is the exact (MLE-wrapped) JSON sent.
// ---------------------------------------------------------------------------
function xPayToken(sharedSecret: string, url: URL, body: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const resourcePath = url.pathname
    .replace(/^\/(vacp|vdp)\//, "")
    .replace(/^\//, "");
  const query = url.search.slice(1);
  const mac = createHmac("sha256", Buffer.from(sharedSecret, "utf8"))
    .update(`${ts}${resourcePath}${query}${body}`)
    .digest("hex");
  return `xv2:${ts}:${mac}`;
}

// ---------------------------------------------------------------------------
// Message Level Encryption — compact JWE, RSA-OAEP-256 + A128GCM, kid=keyId,
// wrapped as {"encData": "<jwe>"}.
// [VERIFIED] algorithm/enc/envelope/`keyId` header match visa/ai mle.ts (which
// uses node-jose). [ASSUMED] this hand-rolled node:crypto JWE is byte-for-byte
// acceptable to Visa; node-jose is not a dependency here and we may not add
// one (package.json is owned by another workstream).
// ---------------------------------------------------------------------------
function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mleEncrypt(
  payload: unknown,
  serverCertPem: string,
  keyId: string,
): string {
  const header = {
    alg: "RSA-OAEP-256",
    enc: "A128GCM",
    kid: keyId,
    iat: Date.now(),
  };
  const protectedHeader = b64url(Buffer.from(JSON.stringify(header), "utf8"));
  const cek = randomBytes(16);
  const publicKey = new X509Certificate(serverCertPem).publicKey;
  const encryptedKey = publicEncrypt(
    {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    cek,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", cek, iv);
  cipher.setAAD(Buffer.from(protectedHeader, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const jwe = [
    protectedHeader,
    b64url(encryptedKey),
    b64url(iv),
    b64url(ciphertext),
    b64url(tag),
  ].join(".");
  return JSON.stringify({ encData: jwe });
}

function mleDecrypt(body: unknown, privateKeyPem: string): unknown {
  if (!body || typeof body !== "object" || !("encData" in body)) return body;
  const encData = (body as { encData: unknown }).encData;
  if (typeof encData !== "string") return body;
  const parts = encData.split(".");
  if (parts.length !== 5) throw new Error("malformed MLE response");
  const [h, ek, iv, ct, tag] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
    enc?: string;
  };
  const cek = privateDecrypt(
    {
      key: createPrivateKey(privateKeyPem),
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(ek, "base64url"),
  );
  const alg =
    header.enc === "A256GCM"
      ? "aes-256-gcm"
      : header.enc === "A192GCM"
        ? "aes-192-gcm"
        : "aes-128-gcm";
  const decipher = createDecipheriv(alg, cek, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(h, "ascii"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// Transport. node:https so optional two-way SSL (client cert + key) works.
// [VERIFIED] VIC sample sends ?apikey=, headers x-pay-token, x-request-id,
// keyId, Content-Type: application/json.
// ---------------------------------------------------------------------------
class VisaStepError extends Error {}

async function vicPost(
  cfg: VisaConfig,
  step: string,
  path: string,
  payload: Record<string, unknown>,
  deadline: number,
): Promise<Record<string, unknown>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new VisaStepError(`Visa ${step} timed out`);
  const url = new URL(`${cfg.baseUrl}${path}`);
  url.searchParams.set("apikey", cfg.apiKey);
  const body = mleEncrypt(payload, cfg.mleServerCertPem, cfg.mleKeyId);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-pay-token": xPayToken(cfg.sharedSecret, url, body),
    "x-request-id": randomUUID(),
    keyId: cfg.mleKeyId,
    "Content-Length": String(Buffer.byteLength(body)),
  };
  if (cfg.basicAuth) {
    // [ASSUMED] only needed if Visa enables two-way SSL on the project.
    headers.Authorization =
      "Basic " +
      Buffer.from(`${cfg.basicAuth.userId}:${cfg.basicAuth.password}`).toString(
        "base64",
      );
  }

  const { status, text } = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(remaining),
          ...(cfg.tls ? { cert: cfg.tls.certPem, key: cfg.tls.keyPem } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  ).catch((err: unknown) => {
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    // Do not echo err.message: TLS/HTTP errors can quote request details.
    throw new VisaStepError(
      timedOut ? `Visa ${step} timed out` : `Visa ${step} network error`,
    );
  });

  if (status < 200 || status >= 300) {
    // Status only; the body (even decrypted) is never surfaced.
    throw new VisaStepError(`Visa ${step} failed (HTTP ${status})`);
  }
  let parsed: unknown;
  try {
    parsed = mleDecrypt(
      text ? (JSON.parse(text) as unknown) : {},
      cfg.mlePrivateKeyPem,
    );
  } catch {
    throw new VisaStepError(`Visa ${step} returned an unreadable response`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new VisaStepError(`Visa ${step} returned an unexpected response`);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Payload builders. Field names [VERIFIED] against visa/ai
// apps/shared-utils/payload-builders/*.ts. Values marked [ASSUMED].
// ---------------------------------------------------------------------------

/** Deterministic UUID-shaped id from the idempotency key, so a retried
 *  pay() correlates with the first attempt in Visa's logs. [ASSUMED] Visa
 *  does not document dedupe on clientReferenceId; real idempotency is the
 *  backend's job (orders keyed by idempotencyKey). */
function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** [ASSUMED] amounts are decimal dollar strings: the sample mandate uses
 *  "800.00" and the credentials sample "710" under that threshold. */
function dollars(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function clientObject(cfg: VisaConfig) {
  return {
    externalClientId: cfg.externalClientId,
    externalAppId: cfg.externalAppId,
  };
}

function appInstance(cfg: VisaConfig) {
  // [ASSUMED] Errand Line is a phone call, not an app on a device. Visa's
  // sample sends a mobile device profile; we describe our server instead.
  return {
    userAgent: "ErrandLine/0.1",
    applicationName: "Errand Line",
    countryCode: "US",
    clientDeviceId: uuidFrom(`device:${cfg.consumerId}`),
    deviceData: {
      type: "Server",
      manufacturer: "Convex",
      brand: "Convex",
      model: "action",
    },
  };
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------
export const pay = internalAction({
  args: {
    orderId: v.string(),
    amountCents: v.number(),
    idempotencyKey: v.string(),
    // The order's store; defaults to the demo merchant.
    merchantName: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<PayResult> => {
    const merchantName =
      args.merchantName?.trim().slice(0, 100) || DEFAULT_MERCHANT_NAME;
    const cfg = loadConfig();
    if (!cfg) return { ok: false, error: NOT_CONFIGURED };
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      return { ok: false, error: "Invalid amount" };
    }

    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const clientReferenceId = uuidFrom(`order:${args.idempotencyKey}`);
    const transactionReferenceId = uuidFrom(`txn:${args.idempotencyKey}`);
    const amount = dollars(args.amountCents);
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      // 1. Purchase instruction. [VERIFIED] path + field names.
      // [ASSUMED] assuranceData: the sample's static DEVICE verification is
      // accepted in sandbox. Production requires a Visa Passkey (FIDO)
      // assertion from the cardholder, which a phone-only caller cannot give;
      // the family member would set up a standing instruction instead.
      const instruction = await vicPost(
        cfg,
        "purchase instruction",
        "/vacp/v1/instructions",
        {
          clientReferenceId,
          client: clientObject(cfg),
          appInstance: appInstance(cfg),
          consumerId: cfg.consumerId,
          tokenId: cfg.tokenId,
          assuranceData: [
            {
              verificationType: "DEVICE",
              verificationEntity: "10",
              verificationEvents: ["01", "02"],
              verificationMethod: "02",
              verificationResults: "01",
              verificationTimestamp: String(nowSec),
            },
          ],
          mandates: [
            {
              mandateId: uuidFrom(`mandate:${args.idempotencyKey}`),
              preferredMerchantName: merchantName,
              merchantCategory: "Grocery",
              merchantCategoryCode: "5411", // [ASSUMED] grocery MCC
              declineThreshold: { amount, currencyCode: "USD" },
              effectiveUntilTime: String(nowSec + 3600),
              quantity: "1",
              description: `Errand Line order ${args.orderId}`,
            },
          ],
          consumerPrompt: `Errand Line order ${args.orderId}`,
        },
        deadline,
      );
      const instructionId = instruction.instructionId;
      if (typeof instructionId !== "string" || instructionId === "") {
        return {
          ok: false,
          error: "Visa purchase instruction returned no instructionId",
        };
      }

      // 2. Payment credentials. [VERIFIED] path + field names. The response
      // carries transactionCredentials (token PAN/expiry/cryptogram). We only
      // check that it is present, then drop the whole object.
      const creds = await vicPost(
        cfg,
        "payment credentials",
        `/vacp/v1/instructions/${encodeURIComponent(instructionId)}/credentials`,
        {
          clientReferenceId,
          client: clientObject(cfg),
          instructionId,
          tokenId: cfg.tokenId,
          transactionData: [
            {
              transactionType: "PURCHASE",
              transactionReferenceId,
              transactionAmount: {
                transactionCurrencyCode: "USD",
                transactionAmount: amount,
              },
              merchantName,
              merchantCountryCode: "US",
              merchantUrl: MERCHANT_URL,
            },
          ],
        },
        deadline,
      );
      const released =
        "transactionCredentials" in creds || creds.status === "APPROVED";
      // [ASSUMED] response shape; if Visa signals a decline some other way
      // this needs adjusting with real responses.
      if (!released) {
        return {
          ok: false,
          error: "Visa declined to release payment credentials",
        };
      }

      // 3. Outcome signal. [VERIFIED] path + field names. [ASSUMED] with no
      // real merchant/acquirer in the loop, we report a simulated sandbox
      // approval. Best-effort: failures do not fail the order.
      try {
        await vicPost(
          cfg,
          "confirmation",
          `/vacp/v1/instructions/${encodeURIComponent(instructionId)}/confirmations`,
          {
            clientReferenceId,
            instructionId,
            confirmationData: [
              {
                transactionReferenceId,
                paymentConfirmationData: {
                  transactionType: "PURCHASE",
                  transactionStatus: "APPROVED",
                  transactionTimestamp: String(Math.floor(Date.now() / 1000)),
                  responseCode: "00",
                  transactionAmount: {
                    transactionAmount: amount,
                    transactionCurrencyCode: "USD",
                  },
                  cardEntryMode: "ECOMMERCE",
                },
                orderData: {
                  orderId: args.orderId,
                  orderStatus: "COMPLETED",
                  orderDate: String(Math.floor(Date.now() / 1000)),
                  transactionAmount: {
                    transactionAmount: amount,
                    transactionCurrencyCode: "USD",
                  },
                },
                merchantData: { merchantName },
              },
            ],
          },
          deadline,
        );
      } catch (err) {
        console.warn(
          `visaRail: confirmation not sent for order ${args.orderId}: ${
            err instanceof VisaStepError ? err.message : "unexpected error"
          }`,
        );
      }

      // Only identifiers, never credentials.
      return {
        ok: true,
        tokenRef: `vic:${instructionId}:${transactionReferenceId}`,
      };
    } catch (err) {
      const error =
        err instanceof VisaStepError ? err.message : "Visa payment failed";
      console.warn(`visaRail: order ${args.orderId}: ${error}`);
      return { ok: false, error };
    }
  },
});
