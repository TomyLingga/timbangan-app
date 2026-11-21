import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { authSessions, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { accountOf, type Guards, loadAccount } from "./guard.js";
import { verifyPassword } from "./passwords.js";
import { clearSessionCookie, issueSession, REFRESH_COOKIE, type SessionClient } from "./sessions.js";
import { LoginThrottle } from "./throttle.js";
import { hashRefreshToken } from "./tokens.js";

const loginBody = z.object({
  username: z.string("Username wajib diisi.").trim().min(1, "Username wajib diisi.").max(200, "Username terlalu panjang."),
  password: z.string("Password wajib diisi.").min(1, "Password wajib diisi.").max(1000, "Password terlalu panjang."),
  client: z.enum(["web", "android", "ios"], "Jenis aplikasi harus web, android, atau ios.").optional(),
});

/** The phone app sends its refresh token in the body; the browser sends its cookie. */
const tokenBody = z.object({ refreshToken: z.string().min(1).max(200).optional() }).nullish();

/** The token presented and which kind of session it must belong to. */
function presentedToken(request: { cookies: Record<string, string | undefined>; body: unknown }): { token: string; phone: boolean } | null {
  const parsed = tokenBody.safeParse(request.body);
  const fromBody = parsed.success ? parsed.data?.refreshToken : undefined;
  if (fromBody) return { token: fromBody, phone: true };
  const fromCookie = request.cookies[REFRESH_COOKIE];
  return fromCookie ? { token: fromCookie, phone: false } : null;
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext, guards: Guards): void {
  const orm = context.database.db;
  const throttle = new LoginThrottle(context.now);

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const username = body.username.toLowerCase();
    if (throttle.isBlocked(username)) {
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Terlalu banyak percobaan masuk. Coba lagi 15 menit lagi.");
    }
    const [user] = await orm
      .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
      .from(users)
      .where(eq(sql`lower(${users.username})`, username));
    const valid = user?.isActive === true && user.passwordHash !== null && (await verifyPassword(user.passwordHash, body.password));
    if (!user || !valid) {
      throttle.recordFailure(username);
      throw new AppError(401, "INVALID_CREDENTIALS", "Username atau password salah.");
    }
    throttle.reset(username);
    await orm.update(users).set({ lastLoginAt: context.now() }).where(eq(users.id, user.id));
    const client = (body.client ?? "web").toUpperCase() as SessionClient;
    const session = await issueSession(context, orm, request, reply, user.id, client);
    return { ...session, user: await loadAccount(orm, user.id) };
  });

  // Rotation: the presented token is revoked in the same transaction that creates its successor, so a
  // token works once. A token that is unknown, used, revoked or expired gets 401.
  app.post("/api/auth/refresh", async (request, reply) => {
    const presented = presentedToken(request);
    const now = context.now();
    const issued = !presented
      ? null
      : await orm.transaction(async (tx) => {
          const [session] = await tx
            .update(authSessions)
            .set({ revokedAt: now, lastUsedAt: now })
            .where(
              and(
                eq(authSessions.tokenHash, hashRefreshToken(presented.token)),
                isNull(authSessions.revokedAt),
                gt(authSessions.expiresAt, now),
                // a phone token only works from the body, a web token only as a cookie
                presented.phone ? ne(authSessions.client, "WEB") : eq(authSessions.client, "WEB"),
              ),
            )
            .returning({ userId: authSessions.userId, client: authSessions.client });
          if (!session) return null;
          const [user] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, session.userId));
          if (!user?.isActive) return null;
          return issueSession(context, tx, request, reply, session.userId, session.client);
        });
    if (!issued) {
      if (!presented?.phone) clearSessionCookie(reply);
      throw new AppError(401, "INVALID_SESSION", "Sesi sudah berakhir. Silakan masuk lagi.");
    }
    return issued;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const presented = presentedToken(request);
    if (presented) {
      await orm
        .update(authSessions)
        .set({ revokedAt: context.now() })
        .where(and(eq(authSessions.tokenHash, hashRefreshToken(presented.token)), isNull(authSessions.revokedAt)));
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/me", { preHandler: [guards.authenticate] }, async (request) => ({ user: accountOf(request) }));
}
