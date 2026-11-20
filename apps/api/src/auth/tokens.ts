import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const key = (secret: string) => new TextEncoder().encode(secret);

/** Access token: a JWT (HS256) that carries the user id and its lifetime. Roles are read from the database per request. */
export function signAccessToken(secret: string, userId: number, ttlSeconds: number, now: Date): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(key(secret));
}

/** The user id of a valid token, or null (wrong signature, expired, not ours). */
export async function verifyAccessToken(secret: string, token: string, now: Date): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], currentDate: now, requiredClaims: ["sub", "exp"] });
    const userId = Number(payload.sub);
    return Number.isSafeInteger(userId) ? userId : null;
  } catch {
    return null;
  }
}

/** Only the hash of a refresh token is stored. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A refresh token: 32 random bytes, sent to the browser in base64url. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}
