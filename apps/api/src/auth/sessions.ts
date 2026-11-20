import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import type { Orm } from "../db/client.js";
import { authSessions } from "../db/schema.js";
import { newRefreshToken, signAccessToken } from "./tokens.js";

export const REFRESH_COOKIE = "refresh_token";
const COOKIE_PATH = "/api/auth";
const DAY_S = 24 * 3600;

const isLocalHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

/**
 * Starts a session for the user: stores the hash of a new refresh token, sends the token as an httpOnly
 * cookie and answers a new access token. `orm` may be a transaction.
 */
export async function issueSession(context: AppContext, orm: Orm, request: FastifyRequest, reply: FastifyReply, userId: number): Promise<string> {
  const now = context.now();
  const maxAge = context.config.refreshTokenTtlDays * DAY_S;
  const refresh = newRefreshToken();
  await orm.insert(authSessions).values({
    userId,
    tokenHash: refresh.hash,
    client: "WEB",
    ip: request.ip,
    createdAt: now,
    expiresAt: new Date(now.getTime() + maxAge * 1000),
  });
  reply.setCookie(REFRESH_COOKIE, refresh.token, {
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: !isLocalHost(request.hostname),
    maxAge,
  });
  return signAccessToken(context.config.jwtSecret, userId, context.config.accessTokenTtlS, now);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}
