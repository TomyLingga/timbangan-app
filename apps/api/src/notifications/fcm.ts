// Firebase Cloud Messaging, HTTP v1 API, without a client library.
// - Access token: a JWT signed RS256 with the service account key (iss = client_email, scope firebase.messaging,
//   aud = the token endpoint, at most one hour), exchanged at https://oauth2.googleapis.com/token with
//   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer (developers.google.com/identity/protocols/oauth2/service-account).
//   It is kept until five minutes before `expires_in` runs out.
// - Send: POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send with { validate_only?, message }; the
//   answer is the Message with its `name` (firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).
// - Errors: { error: { code, message, status, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
//   errorCode }] } } (firebase.google.com/docs/cloud-messaging/error-codes and .../rest/v1/ErrorCode).
// The key file is read once; nothing of it is ever logged or returned.
import { readFile } from "node:fs/promises";
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { PushMessage, PushOutcome, PushSender } from "./push.js";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_URL = "https://fcm.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const JWT_LIFETIME_S = 3600;
/** A token is renewed this long before Google says it expires. */
const TOKEN_MARGIN_S = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: KeyObject;
}

/** Reads and checks the key file. The error names the problem, never the content. */
export async function readServiceAccount(path: string): Promise<ServiceAccount> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("The FCM service account file could not be read as JSON (FCM_SERVICE_ACCOUNT_FILE).");
  }
  const { type, project_id: projectId, client_email: clientEmail, private_key: privateKey } = parsed;
  if (type !== "service_account" || typeof projectId !== "string" || typeof clientEmail !== "string" || typeof privateKey !== "string") {
    throw new Error("The FCM service account file is not a service account key: it needs type, project_id, client_email and private_key.");
  }
  try {
    return { projectId, clientEmail, privateKey: createPrivateKey(privateKey) };
  } catch {
    throw new Error("The private key in the FCM service account file could not be loaded.");
  }
}

export interface FcmOptions {
  /** Tests point these at a local fake. */
  tokenUrl?: string;
  fcmUrl?: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  clock?: () => number;
}

class TokenError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

const base64url = (value: string | object) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** The wire form of a message, field names as in the v1 reference. */
export function fcmMessage(message: PushMessage): Record<string, unknown> {
  const { android } = message;
  const shown = message.title !== null;
  return {
    token: message.token,
    data: message.data,
    ...(shown ? { notification: { title: message.title, body: message.body ?? "" } } : {}),
    android: {
      priority: android.priority,
      ...(android.ttlS === undefined ? {} : { ttl: `${android.ttlS}s` }),
      // a data-only message carries no notification part, or the phone would show one
      ...(shown && (android.channelId || android.tag) ? { notification: { ...(android.channelId ? { channel_id: android.channelId } : {}), ...(android.tag ? { tag: android.tag } : {}) } } : {}),
    },
  };
}

export class FcmSender implements PushSender {
  readonly provider = "fcm";
  private readonly tokenUrl: string;
  private readonly fcmUrl: string;
  private readonly fetch: typeof fetch;
  private readonly clock: () => number;
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    options: FcmOptions = {},
  ) {
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.fcmUrl = options.fcmUrl ?? FCM_URL;
    this.fetch = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  /** The signed assertion for the token endpoint. */
  assertion(): string {
    const iat = Math.floor(this.clock() / 1000);
    const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iss: this.account.clientEmail, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + JWT_LIFETIME_S })}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), this.account.privateKey).toString("base64url")}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.clock() < this.token.until) return this.token.value;
    let response: Response;
    try {
      response = await this.fetch(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: this.assertion() }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TokenError(`token request failed: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new TokenError(`token request answered ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}`, response.status);
    }
    const lifetimeS = typeof body.expires_in === "number" ? body.expires_in : JWT_LIFETIME_S;
    this.token = { value: body.access_token, until: this.clock() + Math.max(0, lifetimeS - TOKEN_MARGIN_S) * 1000 };
    return body.access_token;
  }

  async send(message: PushMessage, options: { validateOnly?: boolean } = {}): Promise<PushOutcome> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      const failed = error as TokenError;
      return { status: "RETRY", reason: failed.message, httpStatus: failed.httpStatus ?? null };
    }
    let response: Response;
    try {
      response = await this.fetch(`${this.fcmUrl}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...(options.validateOnly ? { validate_only: true } : {}), message: fcmMessage(message) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { status: "RETRY", reason: `send failed: ${error instanceof Error ? error.message : String(error)}`, httpStatus: null };
    }
    const body = (await response.json().catch(() => ({}))) as {
      name?: unknown;
      error?: { status?: unknown; details?: { "@type"?: unknown; errorCode?: unknown }[] };
    };
    if (response.ok) return { status: "SENT", ref: typeof body.name === "string" ? body.name : "" };

    const fcmCode = body.error?.details?.find((detail) => detail["@type"] === FCM_ERROR_TYPE)?.errorCode;
    const errorCode = typeof fcmCode === "string" ? fcmCode : null;
    const code = errorCode ?? (typeof body.error?.status === "string" ? body.error.status : `HTTP_${response.status}`);
    const httpStatus = response.status;
    // our token was refused: get a new one next time
    if (httpStatus === 401 && errorCode !== "THIRD_PARTY_AUTH_ERROR") {
      this.token = null;
      return { status: "RETRY", reason: code, httpStatus };
    }
    // the service account lacks the permission: a setup problem, not a problem of this message
    if (httpStatus === 403 && errorCode === null) return { status: "RETRY", reason: code, httpStatus };
    if (httpStatus === 429 || httpStatus >= 500 || code === "QUOTA_EXCEEDED" || code === "UNAVAILABLE" || code === "INTERNAL") {
      return { status: "RETRY", reason: code, httpStatus };
    }
    return { status: "REJECTED", code, httpStatus, unregistered: code === "UNREGISTERED" };
  }
}

/** The FCM sender of the key file. */
export async function fcmSenderFromFile(path: string, options: FcmOptions = {}): Promise<FcmSender> {
  return new FcmSender(await readServiceAccount(path), options);
}
