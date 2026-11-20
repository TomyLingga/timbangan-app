import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { portalUser, startFakePortal } from "./helpers/fake-portal.js";
import { bearer, PASSWORD, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  const { app, database } = context;
  const rootId = await seedStaff(database, "root", "SUPER_ADMIN");
  const qcId = await seedStaff(database, "qc", "QC_OPERATOR");
  await database.query("update users set employee_no = 'E-0077' where id = $1", [qcId]);
  const company = await seedPartner(database, "PT Angkut Satu");
  const partnerUserId = await seedPartnerUser(database, "angkut", company, "PARTNER_TRANSPORTER");
  const root = await bearer(app, "root");
  const call = (method: "GET" | "PUT" | "PATCH", url: string, payload?: unknown, headers = root) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const audit = () =>
    database.query<Record<string, unknown>>("select user_id::int as user_id, action, entity_type, entity_id::int as entity_id, before, after, at from audit_log order by id");
  return { ...context, rootId, qcId, company, partnerUserId, root, call, audit };
}

describe("GET /api/admin/users", () => {
  it("lists the accounts with their roles and company", async () => {
    const { call, rootId, qcId, partnerUserId, company, clock } = await setup();
    const response = await call("GET", "/api/admin/users");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { id: partnerUserId, kind: "PARTNER", username: "angkut", fullName: "Partner angkut", employeeNo: null, partner: { id: company, name: "PT Angkut Satu" }, roles: ["PARTNER_TRANSPORTER"], isActive: true, lastLoginAt: null },
        { id: qcId, kind: "INTERNAL", username: "qc", fullName: "Staff qc", employeeNo: "E-0077", partner: null, roles: ["QC_OPERATOR"], isActive: true, lastLoginAt: null },
        { id: rootId, kind: "INTERNAL", username: "root", fullName: "Staff root", employeeNo: null, partner: null, roles: ["SUPER_ADMIN"], isActive: true, lastLoginAt: clock.now().toISOString() },
      ],
      total: 3,
    });
  });

  it("matches q against username, full name and employee number, and applies the limit", async () => {
    const { call } = await setup();
    const names = async (query: string) => (await call("GET", `/api/admin/users${query}`)).json().items.map((item: { username: string }) => item.username);
    expect(await names("?q=ANG")).toEqual(["angkut"]);
    expect(await names("?q=staff%20q")).toEqual(["qc"]);
    expect(await names("?q=e-00")).toEqual(["qc"]);
    const limited = (await call("GET", "/api/admin/users?limit=1")).json();
    expect(limited.items).toHaveLength(1);
    expect(limited.total).toBe(3);
    expect((await call("GET", "/api/admin/users?limit=0")).statusCode).toBe(400);
  });

  it("is for SUPER_ADMIN only, like every route under /api/admin/users and /api/admin/roles", async () => {
    const { app, call, database, qcId } = await setup();
    await seedStaff(database, "logistics", "LOGISTICS_ADMIN");
    for (const username of ["logistics", "angkut"]) {
      const headers = await bearer(app, username);
      expect((await call("GET", "/api/admin/users", undefined, headers)).statusCode).toBe(403);
      expect((await call("GET", "/api/admin/roles", undefined, headers)).statusCode).toBe(403);
      expect((await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: [] }, headers)).statusCode).toBe(403);
      expect((await call("PATCH", `/api/admin/users/${qcId}`, { isActive: false }, headers)).statusCode).toBe(403);
    }
    expect((await call("GET", "/api/admin/users", undefined, {} as never)).statusCode).toBe(401);
    expect(await database.query("select count(*)::int as n from audit_log")).toEqual([{ n: 0 }]);
  });
});

describe("GET /api/admin/roles", () => {
  it("lists the roles with their scope", async () => {
    const { call } = await setup();
    const { items } = (await call("GET", "/api/admin/roles")).json() as { items: { code: string; name: string; scope: string }[] };
    expect(items).toHaveLength(14);
    expect(items.map((item) => item.code)).toEqual([...items.map((item) => item.code)].sort());
    expect(items.find((item) => item.code === "PARTNER_CUSTOMER")).toEqual({ code: "PARTNER_CUSTOMER", name: "Akun customer", scope: "PARTNER" });
  });
});

describe("PUT /api/admin/users/:id/roles", () => {
  it("replaces the roles and writes one audit row", async () => {
    const { call, database, qcId, rootId, audit, clock } = await setup();
    const response = await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: ["LOGISTICS_ADMIN", "QC_SUPERVISOR", "LOGISTICS_ADMIN"] });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: qcId, roles: ["LOGISTICS_ADMIN", "QC_SUPERVISOR"] });
    expect(await database.query("select role_code, site_id, granted_by::int as granted_by from user_roles where user_id = $1 order by role_code", [qcId])).toEqual([
      { role_code: "LOGISTICS_ADMIN", site_id: null, granted_by: rootId },
      { role_code: "QC_SUPERVISOR", site_id: null, granted_by: rootId },
    ]);
    expect(await audit()).toEqual([
      { user_id: rootId, action: "USER_ROLES_SET", entity_type: "user", entity_id: qcId, before: { roles: ["QC_OPERATOR"] }, after: { roles: ["LOGISTICS_ADMIN", "QC_SUPERVISOR"] }, at: clock.now() },
    ]);

    // the same roles again are not a change
    expect((await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: ["QC_SUPERVISOR", "LOGISTICS_ADMIN"] })).statusCode).toBe(200);
    expect(await audit()).toHaveLength(1);
    // an empty list takes every role away
    expect((await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: [] })).json().user.roles).toEqual([]);
    expect(await audit()).toHaveLength(2);
  });

  it("answers 400 VALIDATION for a role that does not exist or belongs to the other kind of account", async () => {
    const { call, qcId, partnerUserId, audit } = await setup();
    const unknown = await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: ["QC_OPERATOR", "NOT_A_ROLE"] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      error: { code: "VALIDATION", message: "Data yang dikirim tidak valid.", fields: [{ field: "roles", message: "Peran NOT_A_ROLE tidak ada." }] },
    });
    const wrongScope = await call("PUT", `/api/admin/users/${partnerUserId}/roles`, { roles: ["LOGISTICS_ADMIN"] });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json().error.fields).toEqual([{ field: "roles", message: "Peran LOGISTICS_ADMIN bukan untuk akun PARTNER." }]);
    expect((await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: "QC_OPERATOR" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/admin/users/999999/roles", { roles: [] })).statusCode).toBe(404);
    expect((await call("PUT", "/api/admin/users/abc/roles", { roles: [] })).statusCode).toBe(400);
    expect(await audit()).toEqual([]);
  });

  it("does not let an admin remove SUPER_ADMIN from their own account", async () => {
    const { call, rootId, database } = await setup();
    const response = await call("PUT", `/api/admin/users/${rootId}/roles`, { roles: ["LOGISTICS_ADMIN"] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "LAST_ADMIN_SELF", message: "Anda tidak dapat mencabut peran SUPER_ADMIN dari akun sendiri." } });
    expect(await database.query("select role_code from user_roles where user_id = $1", [rootId])).toEqual([{ role_code: "SUPER_ADMIN" }]);
    // adding a role to oneself is fine
    expect((await call("PUT", `/api/admin/users/${rootId}/roles`, { roles: ["SUPER_ADMIN", "MANAGEMENT"] })).statusCode).toBe(200);
  });
});

describe("PATCH /api/admin/users/:id", () => {
  it("deactivates an account, revokes its sessions and writes one audit row", async () => {
    const { app, call, database, qcId, rootId, audit, clock } = await setup();
    const qc = await bearer(app, "qc");
    const response = await call("PATCH", `/api/admin/users/${qcId}`, { isActive: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: qcId, isActive: false });

    expect(await database.query("select count(*)::int as n from auth_sessions where user_id = $1 and revoked_at is null", [qcId])).toEqual([{ n: 0 }]);
    expect(await database.query("select count(*)::int as n from auth_sessions where user_id = $1 and revoked_at is null", [rootId])).toEqual([{ n: 1 }]);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: qc })).statusCode).toBe(401);
    expect(await audit()).toEqual([
      { user_id: rootId, action: "USER_DEACTIVATED", entity_type: "user", entity_id: qcId, before: { isActive: true }, after: { isActive: false }, at: clock.now() },
    ]);

    // no change, no row; then back on
    await call("PATCH", `/api/admin/users/${qcId}`, { isActive: false });
    expect(await audit()).toHaveLength(1);
    expect((await call("PATCH", `/api/admin/users/${qcId}`, { isActive: true })).json().user.isActive).toBe(true);
    expect((await audit())[1]).toMatchObject({ action: "USER_ACTIVATED", before: { isActive: false }, after: { isActive: true } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "qc", password: PASSWORD } })).statusCode).toBe(200);
  });

  it("refuses a change of one's own account, an unknown user and a body without isActive", async () => {
    const { call, rootId, qcId, audit } = await setup();
    const self = await call("PATCH", `/api/admin/users/${rootId}`, { isActive: false });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toEqual({ error: { code: "SELF_CHANGE", message: "Anda tidak dapat mengubah status akun sendiri." } });
    expect((await call("PATCH", "/api/admin/users/999999", { isActive: false })).statusCode).toBe(404);
    const invalid = await call("PATCH", `/api/admin/users/${qcId}`, { isActive: "no" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.fields).toEqual([{ field: "isActive", message: "isActive harus true atau false." }]);
    expect(await audit()).toEqual([]);
  });
});

describe("portal sign-in when the email is already a username", () => {
  it("gives the new portal account the username <email>#sso instead of failing", async () => {
    const portal = await startFakePortal();
    const { app, database } = await testApp({ PORTAL_API_URL: portal.apiUrl, PORTAL_WEB_URL: "http://portal.test", PORTAL_APP_NAME: "Timbangan" });
    const localId = await seedStaff(database, "Budi.Santoso@example.test", "QC_OPERATOR");
    portal.ticket("ticket-1", portalUser());

    const response = await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "ticket-1", appId: "0f3a8e9c-2b4d-4c6e-8f10-123456789abc" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "budi.santoso@example.test#sso", roles: [] });
    expect(response.json().user.id).not.toBe(localId);
    expect(await database.query("select username from users order by id")).toEqual([{ username: "Budi.Santoso@example.test" }, { username: "budi.santoso@example.test#sso" }]);

    // the next sign-in finds the same account again
    portal.ticket("ticket-2", portalUser());
    await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "ticket-2", appId: "0f3a8e9c-2b4d-4c6e-8f10-123456789abc" } });
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 2 }]);
  });
});
