import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { portalUser, startFakePortal } from "./helpers/fake-portal.js";

const APP_ID = "0f3a8e9c-2b4d-4c6e-8f10-123456789abc";
const SSO_REJECTED = { error: { code: "SSO_REJECTED", message: "Masuk lewat portal ditolak. Buka aplikasi ini lagi dari portal." } };

async function withPortal() {
  const portal = await startFakePortal();
  const context = await testApp({ PORTAL_API_URL: portal.apiUrl, PORTAL_WEB_URL: "http://portal.test", PORTAL_APP_NAME: "Timbangan Registrasi" });
  const exchange = (token: string, appId: string = APP_ID) =>
    context.app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token, appId } });
  return { ...context, portal, exchange };
}

describe("GET /api/auth/sso/start", () => {
  it("sends the browser to the portal's launch page with the application name", async () => {
    const { app } = await withPortal();
    const response = await app.inject({ method: "GET", url: "/api/auth/sso/start" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://portal.test/launch?app=Timbangan%20Registrasi");
  });

  it("answers 503 NOT_CONFIGURED when the portal settings are incomplete", async () => {
    const { app } = await testApp({ PORTAL_WEB_URL: "http://portal.test" });
    const expected = { error: { code: "NOT_CONFIGURED", message: "Portal perusahaan belum diatur di server." } };
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/start" });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toEqual(expected);
    const exchange = await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "t", appId: APP_ID } });
    expect(exchange.statusCode).toBe(503);
    expect(exchange.json()).toEqual(expected);
  });
});

describe("POST /api/auth/sso/exchange", () => {
  it("creates the staff account without roles on the first sign-in and starts a session", async () => {
    const { app, database, portal, exchange, clock } = await withPortal();
    portal.ticket("ticket-1", portalUser());

    const response = await exchange("ticket-1");
    expect(response.statusCode).toBe(200);
    expect(portal.requests).toEqual([
      { method: "POST", url: "/api/sso/verify", contentType: "application/json", body: { token: "ticket-1", app_id: APP_ID } },
    ]);

    const [row] = await database.query<Record<string, unknown>>(
      "select id::int as id, kind, username, full_name, employee_no, sso_subject, sso_profile, password_hash, partner_id, is_active, last_login_at from users",
    );
    expect(row).toEqual({
      id: expect.any(Number),
      kind: "INTERNAL",
      username: "budi.santoso@inl.co.id",
      full_name: "Budi Santoso",
      employee_no: "INL-0421",
      sso_subject: "5b0c2a52-7d1f-4d0e-9b57-0a8f1f6f0001",
      sso_profile: {
        jabatan: "Staff Logistik",
        unit: { kode: "LOG", nama: "Logistik", path: "Operasional / Logistik" },
        grade: { kode: "G4", label: "Staff", level: 4 },
      },
      password_hash: null,
      partner_id: null,
      is_active: true,
      last_login_at: clock.now(),
    });

    const body = response.json() as { accessToken: string; user: unknown };
    expect(body.user).toEqual({ id: row?.id, kind: "INTERNAL", username: "budi.santoso@inl.co.id", fullName: "Budi Santoso", roles: [], partner: null });
    expect(response.cookies.find((item) => item.name === "refresh_token")).toMatchObject({ path: "/api/auth", httpOnly: true });
    expect(await database.query("select count(*)::int as n from auth_sessions where user_id = $1", [row?.id])).toEqual([{ n: 1 }]);
    expect(await database.query("select count(*)::int as n from user_roles")).toEqual([{ n: 0 }]);

    // the access token belongs to the new account, which has no role yet
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.json()).toEqual({ user: body.user });
  });

  it("updates name and profile on a later sign-in and keeps the account and its roles", async () => {
    const { app, database, portal, exchange } = await withPortal();
    portal.ticket("ticket-1", portalUser());
    await exchange("ticket-1");
    await database.query("insert into user_roles (user_id, role_code) select id, 'LOGISTICS_ADMIN' from users");

    portal.ticket(
      "ticket-2",
      portalUser({}, { nama: "Budi Santoso, S.T.", nrk: "INL-0421B", jabatan: "Supervisor Logistik", grade: { id: "g2", kode: "G5", label: "Supervisor", level: 5 }, unit: null }),
    );
    const response = await exchange("ticket-2");
    expect(response.statusCode).toBe(200);

    expect(await database.query("select username, full_name, employee_no, sso_profile from users")).toEqual([
      {
        username: "budi.santoso@inl.co.id",
        full_name: "Budi Santoso, S.T.",
        employee_no: "INL-0421B",
        sso_profile: { jabatan: "Supervisor Logistik", unit: null, grade: { kode: "G5", label: "Supervisor", level: 5 } },
      },
    ]);
    const { accessToken, user } = response.json() as { accessToken: string; user: { roles: string[]; fullName: string } };
    expect(user).toMatchObject({ fullName: "Budi Santoso, S.T.", roles: ["LOGISTICS_ADMIN"] });
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.json().user.roles).toEqual(["LOGISTICS_ADMIN"]);
  });

  it("answers 401 SSO_REJECTED when the portal refuses the token, and creates nothing", async () => {
    const { database, portal, exchange } = await withPortal();
    const response = await exchange("never-issued");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(SSO_REJECTED);
    expect(response.cookies).toEqual([]);

    // a token works once at the portal
    portal.ticket("ticket-1", portalUser());
    expect((await exchange("ticket-1")).statusCode).toBe(200);
    expect((await exchange("ticket-1")).statusCode).toBe(401);
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 1 }]);
  });

  it("answers 401 SSO_REJECTED for a user who is inactive at the portal", async () => {
    const { database, portal, exchange } = await withPortal();
    portal.ticket("refused", { error: "User tidak aktif" });
    expect((await exchange("refused")).json()).toEqual(SSO_REJECTED);
    portal.ticket("flagged", portalUser({ isActive: false }));
    expect((await exchange("flagged")).json()).toEqual(SSO_REJECTED);
    portal.ticket("no-employee", portalUser({ employeeId: null, employee: null }));
    expect((await exchange("no-employee")).json()).toEqual(SSO_REJECTED);
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 0 }]);
  });

  it("answers 401 SSO_REJECTED for a user who is inactive here", async () => {
    const { database, portal, exchange } = await withPortal();
    portal.ticket("ticket-1", portalUser());
    await exchange("ticket-1");
    await database.query("update users set is_active = false");

    portal.ticket("ticket-2", portalUser({}, { nama: "Nama Baru" }));
    const response = await exchange("ticket-2");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(SSO_REJECTED);
    expect(await database.query("select full_name from users")).toEqual([{ full_name: "Budi Santoso" }]);
    expect(await database.query("select count(*)::int as n from auth_sessions")).toEqual([{ n: 1 }]);
  });

  it("answers 502 PORTAL_UNAVAILABLE when the portal cannot be reached", async () => {
    const { portal, exchange } = await withPortal();
    await portal.close();
    const response = await exchange("ticket-1");
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: { code: "PORTAL_UNAVAILABLE", message: "Portal perusahaan tidak dapat dihubungi. Coba lagi sebentar." } });
  });

  it("answers 400 VALIDATION without calling the portal when token or appId is missing or malformed", async () => {
    const { app, portal } = await withPortal();
    const response = await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "", appId: "not-a-uuid" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "VALIDATION",
      fields: [
        { field: "token", message: "Token wajib diisi." },
        { field: "appId", message: "appId tidak valid." },
      ],
    });
    expect(portal.requests).toEqual([]);
  });
});
