import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { PASSWORD, seedStaff } from "./helpers/users.js";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const INVALID_SESSION = { error: { code: "INVALID_SESSION", message: "Sesi sudah berakhir. Silakan masuk lagi." } };

async function signedIn() {
  const context = await testApp();
  const userId = await seedStaff(context.database, "admin");
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  const token = response.cookies.find((item) => item.name === "refresh_token")?.value ?? "";
  return { ...context, userId, token };
}

const refresh = (app: FastifyInstance, token?: string) =>
  app.inject({ method: "POST", url: "/api/auth/refresh", cookies: token === undefined ? {} : { refresh_token: token } });
const logout = (app: FastifyInstance, token?: string) =>
  app.inject({ method: "POST", url: "/api/auth/logout", cookies: token === undefined ? {} : { refresh_token: token } });

describe("POST /api/auth/refresh", () => {
  it("rotates the refresh token: the old session is revoked and a new one created", async () => {
    const { app, database, clock, token } = await signedIn();
    clock.advance(60_000);

    const response = await refresh(app, token);
    expect(response.statusCode).toBe(200);
    const { accessToken } = response.json() as { accessToken: string };
    const cookie = response.cookies.find((item) => item.name === "refresh_token");
    expect(cookie).toMatchObject({ path: "/api/auth", httpOnly: true, sameSite: "Lax" });
    expect(cookie?.value).not.toBe(token);
    expect(Object.keys(response.json())).toEqual(["accessToken"]);

    const sessions = await database.query<{ token_hash: string; revoked_at: Date | null; last_used_at: Date | null }>(
      "select token_hash, revoked_at, last_used_at from auth_sessions order by id",
    );
    expect(sessions).toEqual([
      { token_hash: hashOf(token), revoked_at: clock.now(), last_used_at: clock.now() },
      { token_hash: hashOf(cookie?.value ?? ""), revoked_at: null, last_used_at: null },
    ]);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    // the new token can be rotated again
    expect((await refresh(app, cookie?.value)).statusCode).toBe(200);
  });

  it("answers 401 to a token that was already used, and clears the cookie", async () => {
    const { app, database, token } = await signedIn();
    expect((await refresh(app, token)).statusCode).toBe(200);

    const reused = await refresh(app, token);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual(INVALID_SESSION);
    expect(reused.cookies.find((item) => item.name === "refresh_token")).toMatchObject({ value: "", path: "/api/auth" });
    expect(await database.query("select count(*)::int as n from auth_sessions")).toEqual([{ n: 2 }]);
  });

  it("answers 401 without a cookie, to an unknown token, after the session expired, and for an inactive account", async () => {
    const { app, database, clock, token } = await signedIn();
    expect((await refresh(app)).statusCode).toBe(401);
    expect((await refresh(app, "made-up-token")).json()).toEqual(INVALID_SESSION);

    const other = await signedIn();
    other.clock.advance(30 * 24 * 3600 * 1000 + 1000);
    expect((await refresh(other.app, other.token)).statusCode).toBe(401);

    await database.query("update users set is_active = false where username = 'admin'");
    clock.advance(1000);
    expect((await refresh(app, token)).statusCode).toBe(401);
    // the session of an inactive account does not stay usable
    expect(await database.query("select count(*)::int as n from auth_sessions where revoked_at is null")).toEqual([{ n: 0 }]);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const { app, database, clock, token } = await signedIn();
    const response = await logout(app, token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.cookies.find((item) => item.name === "refresh_token")).toMatchObject({ value: "", path: "/api/auth" });
    expect(await database.query("select revoked_at from auth_sessions")).toEqual([{ revoked_at: clock.now() }]);
    expect((await refresh(app, token)).statusCode).toBe(401);
  });

  it("answers the same without a session", async () => {
    const { app } = await signedIn();
    expect((await logout(app)).json()).toEqual({ ok: true });
    expect((await logout(app, "made-up-token")).statusCode).toBe(200);
  });
});
