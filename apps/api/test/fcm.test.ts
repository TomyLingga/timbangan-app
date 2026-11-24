// The FCM HTTP v1 sender against a local fake of Google's token endpoint and of messages:send: the signed assertion,
// the cached access token, the wire form of a message, and how each kind of error is treated.
import { generateKeyPairSync, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { FcmSender, fcmMessage, GOOGLE_TOKEN_URL, readServiceAccount } from "../src/notifications/fcm.js";
import type { PushMessage } from "../src/notifications/push.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ACCOUNT_JSON = { type: "service_account", project_id: "demo-project", client_email: "sender@demo-project.iam.gserviceaccount.test", private_key: PEM };

const MESSAGE: PushMessage = {
  token: "device-token-1",
  title: "Selisih bruto menunggu keputusan",
  body: "TRP-0001",
  data: { type: "EXCEPTION_RAISED", exceptionId: "5", tripId: "9", notificationId: "3" },
  android: { priority: "high", channelId: "keputusan", tag: "exception-5", ttlS: 600 },
};

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

type Answer = { status: number; body: unknown };

async function fakeGoogle() {
  const tokenRequests: URLSearchParams[] = [];
  const sends: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  let tokenAnswer: Answer = { status: 200, body: { access_token: "access-1", expires_in: 3599, token_type: "Bearer" } };
  const sendAnswers: Answer[] = [];
  const server = createServer(async (request, response) => {
    const text = await readBody(request);
    const answer = (value: Answer) => {
      response.writeHead(value.status, { "content-type": "application/json" });
      response.end(JSON.stringify(value.body));
    };
    if (request.url === "/token") {
      tokenRequests.push(new URLSearchParams(text));
      return answer(tokenAnswer);
    }
    if (request.url === "/v1/projects/demo-project/messages:send") {
      sends.push({ authorization: request.headers.authorization, body: JSON.parse(text) });
      return answer(sendAnswers.shift() ?? { status: 200, body: { name: "projects/demo-project/messages/0:1" } });
    }
    answer({ status: 404, body: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    tokenUrl: `${url}/token`,
    fcmUrl: url,
    tokenRequests,
    sends,
    answerToken(value: Answer) {
      tokenAnswer = value;
    },
    answerSend(...values: Answer[]) {
      sendAnswers.push(...values);
    },
  };
}

const fcmError = (status: number, statusText: string, errorCode?: string): Answer => ({
  status,
  body: {
    error: {
      code: status,
      message: "fake",
      status: statusText,
      ...(errorCode ? { details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } : {}),
    },
  },
});

async function setup() {
  const google = await fakeGoogle();
  const file = join(tmpdir(), `fcm-test-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(ACCOUNT_JSON));
  let now = Date.parse("2026-11-24T03:00:00Z");
  const sender = new FcmSender(await readServiceAccount(file), { tokenUrl: google.tokenUrl, fcmUrl: google.fcmUrl, clock: () => now });
  return { google, sender, advance: (ms: number) => (now += ms) };
}

describe("FcmSender", () => {
  it("signs the assertion with the key and sends the message with the access token", async () => {
    const { google, sender } = await setup();
    expect(await sender.send(MESSAGE)).toEqual({ status: "SENT", ref: "projects/demo-project/messages/0:1" });

    const [form] = google.tokenRequests;
    expect(form?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = (form?.get("assertion") ?? "").split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(Date.parse("2026-11-24T03:00:00Z") / 1000);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: ACCOUNT_JSON.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);

    expect(google.sends).toEqual([
      {
        authorization: "Bearer access-1",
        body: {
          message: {
            token: "device-token-1",
            data: MESSAGE.data,
            notification: { title: "Selisih bruto menunggu keputusan", body: "TRP-0001" },
            android: { priority: "high", ttl: "600s", notification: { channel_id: "keputusan", tag: "exception-5" } },
          },
        },
      },
    ]);
  });

  it("keeps the access token until five minutes before it expires", async () => {
    const { google, sender, advance } = await setup();
    await sender.send(MESSAGE);
    advance(3599_000 - 300_000 - 1);
    await sender.send(MESSAGE);
    expect(google.tokenRequests).toHaveLength(1);
    advance(1);
    await sender.send(MESSAGE);
    expect(google.tokenRequests).toHaveLength(2);
  });

  it("sends validate_only when asked", async () => {
    const { google, sender } = await setup();
    await sender.send(MESSAGE, { validateOnly: true });
    expect(google.sends[0]?.body.validate_only).toBe(true);
  });

  it("gives a data-only message no notification part", () => {
    expect(fcmMessage({ token: "t", title: null, body: null, data: { type: "EXCEPTION_CLOSED" }, android: { priority: "high", ttlS: 600 } })).toEqual({
      token: "t",
      data: { type: "EXCEPTION_CLOSED" },
      android: { priority: "high", ttl: "600s" },
    });
  });

  it("refuses for good an unregistered or invalid token, and marks only the unregistered one dead", async () => {
    const { google, sender } = await setup();
    google.answerSend(fcmError(404, "NOT_FOUND", "UNREGISTERED"), fcmError(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"), fcmError(403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH"));
    expect(await sender.send(MESSAGE)).toEqual({ status: "REJECTED", code: "UNREGISTERED", httpStatus: 404, unregistered: true });
    expect(await sender.send(MESSAGE)).toEqual({ status: "REJECTED", code: "INVALID_ARGUMENT", httpStatus: 400, unregistered: false });
    expect(await sender.send(MESSAGE)).toEqual({ status: "REJECTED", code: "SENDER_ID_MISMATCH", httpStatus: 403, unregistered: false });
  });

  it("asks to try again on an overloaded server, a quota, a refused access token or missing permission", async () => {
    const { google, sender } = await setup();
    google.answerSend(fcmError(503, "UNAVAILABLE", "UNAVAILABLE"), fcmError(429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"), fcmError(401, "UNAUTHENTICATED"), fcmError(403, "PERMISSION_DENIED"));
    expect(await sender.send(MESSAGE)).toEqual({ status: "RETRY", reason: "UNAVAILABLE", httpStatus: 503 });
    expect(await sender.send(MESSAGE)).toEqual({ status: "RETRY", reason: "QUOTA_EXCEEDED", httpStatus: 429 });
    expect(await sender.send(MESSAGE)).toEqual({ status: "RETRY", reason: "UNAUTHENTICATED", httpStatus: 401 });
    // the refused access token is not used again
    await sender.send(MESSAGE);
    expect(google.tokenRequests).toHaveLength(2);
  });

  it("asks to try again when the token endpoint refuses the key, without sending", async () => {
    const { google, sender } = await setup();
    google.answerToken({ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } });
    expect(await sender.send(MESSAGE)).toEqual({ status: "RETRY", reason: "token request answered 400 invalid_grant", httpStatus: 400 });
    expect(google.sends).toEqual([]);
  });
});

describe("readServiceAccount", () => {
  it("refuses a file that is not a service account key, without quoting it", async () => {
    const file = join(tmpdir(), `fcm-test-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ ...ACCOUNT_JSON, type: "authorized_user" }));
    const failure = readServiceAccount(file);
    await expect(failure).rejects.toThrow(/not a service account key/);
    await expect(failure).rejects.not.toThrow(/demo-project/);
    await expect(readServiceAccount(join(tmpdir(), `missing-${randomUUID()}.json`))).rejects.toThrow(/could not be read/);
  });
});
