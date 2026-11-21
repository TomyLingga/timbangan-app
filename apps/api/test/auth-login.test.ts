import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { createGuards } from "../src/auth/guard.js";
import { covers, type PermissionLevel } from "../src/auth/permissions.js";
import { testApp } from "./helpers/app.js";
import { bearer, EVERYTHING, LOGISTICS, PASSWORD, seedPartner, seedPartnerUser, seedStaff, TRANSPORTER, VIEWER } from "./helpers/users.js";

const login = (app: Awaited<ReturnType<typeof testApp>>["app"], username: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password }, headers });

const INVALID = { error: { code: "INVALID_CREDENTIALS", message: "Username atau password salah." } };

describe("POST /api/auth/login", () => {
  it("signs a staff account in: access token, user, refresh cookie and a stored session", async () => {
    const { app, database, clock } = await testApp();
    const id = await seedStaff(database, "Darurat", EVERYTHING);

    const response = await login(app, "darurat", PASSWORD);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accessToken: string; user: unknown };
    expect(body.user).toEqual({ id, kind: "INTERNAL", username: "Darurat", fullName: "Staff Darurat", permissions: EVERYTHING, partner: null });

    // the access token carries the user id and its lifetime, nothing else
    const claims = decodeJwt(body.accessToken);
    expect(claims).toEqual({ sub: String(id), iat: Math.floor(clock.now().getTime() / 1000), exp: Math.floor(clock.now().getTime() / 1000) + 900 });

    const cookie = response.cookies.find((item) => item.name === "refresh_token");
    expect(cookie).toMatchObject({ path: "/api/auth", httpOnly: true, sameSite: "Lax", maxAge: 30 * 24 * 3600 });
    expect(cookie?.secure).toBeUndefined();
    expect(Buffer.from(cookie?.value ?? "", "base64url")).toHaveLength(32);

    const sessions = await database.query<{ user_id: number; token_hash: string; client: string; expires_at: Date; revoked_at: Date | null }>(
      "select user_id::int as user_id, token_hash, client, expires_at, revoked_at from auth_sessions",
    );
    expect(sessions).toEqual([
      {
        user_id: id,
        token_hash: createHash("sha256").update(cookie?.value ?? "").digest("hex"),
        client: "WEB",
        expires_at: new Date(clock.now().getTime() + 30 * 24 * 3600 * 1000),
        revoked_at: null,
      },
    ]);
    expect(await database.query("select last_login_at from users where id = $1", [id])).toEqual([{ last_login_at: clock.now() }]);
  });

  it("gives a partner account its company", async () => {
    const { app, database } = await testApp();
    const company = await seedPartner(database, "PT Transporter T", { transporter: true });
    const id = await seedPartnerUser(database, "transporter-t", company, TRANSPORTER);
    const response = await login(app, "transporter-t", PASSWORD);
    expect(response.json().user).toEqual({
      id,
      kind: "PARTNER",
      username: "transporter-t",
      fullName: "Partner transporter-t",
      permissions: TRANSPORTER,
      partner: { id: company, name: "PT Transporter T", isSupplier: false, isTransporter: true, isCustomer: false },
    });
  });

  it("marks the cookie secure unless the request host is localhost or 127.0.0.1", async () => {
    const { app, database } = await testApp();
    await seedStaff(database, "admin");
    const secureOf = async (host: string) => (await login(app, "admin", PASSWORD, { host })).cookies.find((item) => item.name === "refresh_token")?.secure;
    expect(await secureOf("timbangan.example.test")).toBe(true);
    expect(await secureOf("localhost:3100")).toBeUndefined();
    expect(await secureOf("127.0.0.1:3100")).toBeUndefined();
  });

  it("answers 401 with one message for a wrong password, an unknown user, an inactive account and an account without a password", async () => {
    const { app, database } = await testApp();
    await seedStaff(database, "admin");
    await seedStaff(database, "retired");
    await database.query("update users set is_active = false where username = 'retired'");
    await database.query("insert into users (kind, username, full_name, sso_subject) values ('INTERNAL', 'sso-only', 'SSO Only', 'subject-1')");

    for (const [username, password] of [["admin", "wrong-password"], ["nobody", PASSWORD], ["retired", PASSWORD], ["sso-only", PASSWORD]] as const) {
      const response = await login(app, username, password);
      expect(response.statusCode, username).toBe(401);
      expect(response.json(), username).toEqual(INVALID);
      expect(response.cookies).toEqual([]);
    }
    expect(await database.query("select count(*)::int as n from auth_sessions")).toEqual([{ n: 0 }]);
  });

  it("locks a username after 5 failures within 15 minutes, also for the right password", async () => {
    const { app, database, clock } = await testApp();
    await seedStaff(database, "admin");
    await seedStaff(database, "other");

    for (let attempt = 1; attempt <= 5; attempt++) expect((await login(app, "Admin", "wrong-password")).statusCode).toBe(401);
    const locked = await login(app, "admin", PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: { code: "TOO_MANY_ATTEMPTS", message: "Terlalu banyak percobaan masuk. Coba lagi 15 menit lagi." } });
    // another username is not affected
    expect((await login(app, "other", PASSWORD)).statusCode).toBe(200);

    clock.advance(15 * 60 * 1000 + 1);
    expect((await login(app, "admin", PASSWORD)).statusCode).toBe(200);
  });

  it("forgets earlier failures after a successful sign-in", async () => {
    const { app, database } = await testApp();
    await seedStaff(database, "admin");
    for (let attempt = 1; attempt <= 4; attempt++) await login(app, "admin", "wrong-password");
    expect((await login(app, "admin", PASSWORD)).statusCode).toBe(200);
    for (let attempt = 1; attempt <= 4; attempt++) expect((await login(app, "admin", "wrong-password")).statusCode).toBe(401);
    expect((await login(app, "admin", PASSWORD)).statusCode).toBe(200);
  });

  it("answers 400 VALIDATION with the field messages", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION",
        message: "Data yang dikirim tidak valid.",
        fields: [
          { field: "username", message: "Username wajib diisi." },
          { field: "password", message: "Password wajib diisi." },
        ],
      },
    });
  });

  it("answers a body that is not JSON with 400 in the same envelope", async () => {
    const { app } = await testApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });
});

describe("GET /api/me", () => {
  it("answers the signed-in user with the permissions as they are in the database now", async () => {
    const { app, database } = await testApp();
    const id = await seedStaff(database, "admin", LOGISTICS);
    const headers = await bearer(app, "admin");
    await database.query("delete from user_permissions where user_id = $1 and module_code <> 'gate'", [id]);
    await database.query("insert into user_permissions (user_id, module_code, level) values ($1, 'users', 'VIEW')", [id]);
    // a permission on a module that is not active yet is not shown
    await database.query("insert into user_permissions (user_id, module_code, level) values ($1, 'weighbridge', 'EDIT')", [id]);

    const response = await app.inject({ method: "GET", url: "/api/me", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id, kind: "INTERNAL", username: "admin", fullName: "Staff admin", permissions: { gate: "EDIT", users: "VIEW" }, partner: null },
    });
  });

  it("answers 401 without a token, with a broken or foreign token, after it expired, and once the account is inactive", async () => {
    const { app, database, clock, config } = await testApp();
    await seedStaff(database, "admin");
    const headers = await bearer(app, "admin");
    const me = (authorization?: string) => app.inject({ method: "GET", url: "/api/me", headers: authorization ? { authorization } : {} });
    const UNAUTHENTICATED = { error: { code: "UNAUTHENTICATED", message: "Silakan masuk terlebih dahulu." } };

    expect((await me()).statusCode).toBe(401);
    expect((await me()).json()).toEqual(UNAUTHENTICATED);
    expect((await me("Bearer not-a-token")).statusCode).toBe(401);
    expect((await me(headers.authorization.replace("Bearer ", "Basic "))).statusCode).toBe(401);

    const { signAccessToken } = await import("../src/auth/tokens.js");
    const foreign = await signAccessToken("another-secret-another-secret-another-0", 1, 900, clock.now());
    expect((await me(`Bearer ${foreign}`)).statusCode).toBe(401);

    expect((await me(headers.authorization)).statusCode).toBe(200);
    clock.advance(config.accessTokenTtlS * 1000 + 1000);
    expect((await me(headers.authorization)).statusCode).toBe(401);

    const fresh = await bearer(app, "admin");
    await database.query("update users set is_active = false where username = 'admin'");
    expect((await me(fresh.authorization)).json()).toEqual(UNAUTHENTICATED);
  });
});

describe("covers", () => {
  it("orders the levels: EDIT covers CREATE and VIEW, CREATE covers VIEW, nothing covers what is absent", () => {
    const table: [PermissionLevel | undefined, PermissionLevel, boolean][] = [
      ["EDIT", "EDIT", true], ["EDIT", "CREATE", true], ["EDIT", "VIEW", true],
      ["CREATE", "EDIT", false], ["CREATE", "CREATE", true], ["CREATE", "VIEW", true],
      ["VIEW", "EDIT", false], ["VIEW", "CREATE", false], ["VIEW", "VIEW", true],
      [undefined, "VIEW", false],
    ];
    for (const [held, needed, expected] of table) expect(covers(held, needed), `${held} covers ${needed}`).toBe(expected);
  });
});

describe("permission guards", () => {
  async function guarded() {
    const context = await testApp();
    const guards = createGuards({ config: context.config, database: context.database, now: context.clock.now, vcf: null, registryPushTimeoutMs: 5_000 });
    context.app.get("/test/create", { preHandler: [guards.authenticate, guards.requirePermission("vehicles", "CREATE")] }, async () => ({ ok: true }));
    context.app.get("/test/either", { preHandler: [guards.authenticate, guards.requireAnyPermission(["gate", "VIEW"], ["registrations", "VIEW"])] }, async () => ({ ok: true }));
    context.app.get("/test/internal", { preHandler: [guards.authenticate, guards.requireInternal] }, async () => ({ ok: true }));
    const get = async (url: string, username?: string) =>
      context.app.inject({ method: "GET", url, headers: username ? await bearer(context.app, username) : {} });
    return { ...context, get };
  }

  it("lets the level and the levels above it pass, and refuses the level below with 403 FORBIDDEN", async () => {
    const { database, get } = await guarded();
    await seedStaff(database, "viewer", { vehicles: "VIEW" });
    await seedStaff(database, "creator", { vehicles: "CREATE" });
    await seedStaff(database, "editor", { vehicles: "EDIT" });
    await seedStaff(database, "other", { gate: "EDIT" });

    expect((await get("/test/create", "creator")).statusCode).toBe(200);
    expect((await get("/test/create", "editor")).statusCode).toBe(200);
    for (const username of ["viewer", "other"]) {
      const refused = await get("/test/create", username);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: { code: "FORBIDDEN", message: "Anda tidak berhak membuka bagian ini." } });
    }
    expect((await get("/test/create")).statusCode).toBe(401);
  });

  it("lets any of several module levels pass", async () => {
    const { database, get } = await guarded();
    await seedStaff(database, "desk", { gate: "VIEW" });
    await seedStaff(database, "office", { registrations: "EDIT" });
    await seedStaff(database, "fleet", { vehicles: "EDIT" });
    expect((await get("/test/either", "desk")).statusCode).toBe(200);
    expect((await get("/test/either", "office")).statusCode).toBe(200);
    expect((await get("/test/either", "fleet")).statusCode).toBe(403);
  });

  it("answers 403 NO_ACCESS to a staff account without any permission, on every guarded route", async () => {
    const { database, get } = await guarded();
    await seedStaff(database, "newcomer", {});

    for (const url of ["/test/create", "/test/either", "/test/internal"]) {
      const response = await get(url, "newcomer");
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: "NO_ACCESS", message: "Akun Anda belum diberi hak akses. Hubungi admin sistem." } });
    }
  });

  it("refuses a partner account without permissions with FORBIDDEN, and keeps partner accounts off staff-only routes", async () => {
    const { database, get } = await guarded();
    const company = await seedPartner(database, "PKS A");
    await seedPartnerUser(database, "nothing", company, {});
    await seedPartnerUser(database, "pks-a", company, { vehicles: "EDIT", registrations: "EDIT" });
    await seedStaff(database, "qc", VIEWER);

    expect((await get("/test/create", "nothing")).json().error.code).toBe("FORBIDDEN");
    expect((await get("/test/create", "pks-a")).statusCode).toBe(200);
    expect((await get("/test/internal", "pks-a")).json().error.code).toBe("FORBIDDEN");
    expect((await get("/test/internal", "qc")).statusCode).toBe(200);
  });
});
