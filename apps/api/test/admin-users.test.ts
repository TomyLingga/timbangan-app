import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { portalUser, startFakePortal } from "./helpers/fake-portal.js";
import { bearer, EVERYTHING, LOGISTICS, PASSWORD, seedPartner, seedPartnerUser, seedStaff, TRANSPORTER, VIEWER } from "./helpers/users.js";

async function setup() {
  const context = await testApp();
  const { app, database } = context;
  const rootId = await seedStaff(database, "root", EVERYTHING);
  const qcId = await seedStaff(database, "qc", VIEWER);
  await database.query("update users set employee_no = 'E-0077' where id = $1", [qcId]);
  const company = await seedPartner(database, "PT Angkut Satu", { transporter: true });
  const partnerUserId = await seedPartnerUser(database, "angkut", company, TRANSPORTER);
  const root = await bearer(app, "root");
  const call = (method: "GET" | "PUT" | "PATCH", url: string, payload?: unknown, headers = root) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const audit = () =>
    database.query<Record<string, unknown>>("select user_id::int as user_id, action, entity_type, entity_id::int as entity_id, before, after, at from audit_log order by id");
  return { ...context, rootId, qcId, company, partnerUserId, root, call, audit };
}

describe("GET /api/admin/users", () => {
  it("lists the accounts with their permissions and company", async () => {
    const { call, rootId, qcId, partnerUserId, company, clock } = await setup();
    const response = await call("GET", "/api/admin/users");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { id: partnerUserId, kind: "PARTNER", username: "angkut", fullName: "Partner angkut", employeeNo: null, partner: { id: company, name: "PT Angkut Satu" }, permissions: TRANSPORTER, isActive: true, lastLoginAt: null },
        { id: qcId, kind: "INTERNAL", username: "qc", fullName: "Staff qc", employeeNo: "E-0077", partner: null, permissions: VIEWER, isActive: true, lastLoginAt: null },
        { id: rootId, kind: "INTERNAL", username: "root", fullName: "Staff root", employeeNo: null, partner: null, permissions: EVERYTHING, isActive: true, lastLoginAt: clock.now().toISOString() },
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

  it("needs users:VIEW to read and users:EDIT to change, on every route under /api/admin/users and /api/admin/modules", async () => {
    const { app, call, database, qcId } = await setup();
    await seedStaff(database, "logistics", LOGISTICS);
    await seedStaff(database, "reader", { users: "VIEW" });
    for (const username of ["logistics", "angkut"]) {
      const headers = await bearer(app, username);
      expect((await call("GET", "/api/admin/users", undefined, headers)).statusCode).toBe(403);
      expect((await call("GET", "/api/admin/modules", undefined, headers)).statusCode).toBe(403);
    }
    for (const username of ["logistics", "angkut", "reader"]) {
      const headers = await bearer(app, username);
      expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: {} }, headers)).statusCode).toBe(403);
      expect((await call("PATCH", `/api/admin/users/${qcId}`, { isActive: false }, headers)).statusCode).toBe(403);
    }
    const reader = await bearer(app, "reader");
    expect((await call("GET", "/api/admin/users", undefined, reader)).statusCode).toBe(200);
    expect((await call("GET", "/api/admin/modules", undefined, reader)).statusCode).toBe(200);
    expect((await call("GET", "/api/admin/users", undefined, {} as never)).statusCode).toBe(401);
    // the role routes are gone
    expect((await call("GET", "/api/admin/roles")).statusCode).toBe(404);
    expect((await call("PUT", `/api/admin/users/${qcId}/roles`, { roles: [] })).statusCode).toBe(404);
    expect(await database.query("select count(*)::int as n from audit_log")).toEqual([{ n: 0 }]);
  });
});

describe("GET /api/admin/modules", () => {
  it("lists the active modules in their order with the levels that mean something and the partner flag", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/admin/modules")).json()).toEqual({
      items: [
        { code: "contracts", name: "Kontrak", levels: ["VIEW", "EDIT"], partnerAllowed: true },
        { code: "drivers", name: "Supir", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: true },
        { code: "vehicles", name: "Kendaraan", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: true },
        { code: "destinations", name: "Tujuan", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: false },
        { code: "delivery_orders", name: "Delivery Order", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: true },
        { code: "registrations", name: "Registrasi", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: true },
        { code: "gate", name: "Pos registrasi", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: false },
        { code: "rfid_cards", name: "Kartu RFID", levels: ["VIEW", "CREATE", "EDIT"], partnerAllowed: false },
        { code: "users", name: "Pengguna dan hak akses", levels: ["VIEW", "EDIT"], partnerAllowed: false },
      ],
    });
  });
});

describe("PUT /api/admin/users/:id/permissions", () => {
  it("replaces every permission of the account and writes one audit row", async () => {
    const { call, database, qcId, rootId, audit, clock } = await setup();
    const response = await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: { gate: "CREATE", contracts: "VIEW", vehicles: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: qcId, permissions: { contracts: "VIEW", gate: "CREATE" } });
    expect(
      await database.query("select module_code, level, granted_by::int as granted_by, granted_at from user_permissions where user_id = $1 order by module_code", [qcId]),
    ).toEqual([
      { module_code: "contracts", level: "VIEW", granted_by: null, granted_at: expect.any(Date) },
      { module_code: "gate", level: "CREATE", granted_by: rootId, granted_at: clock.now() },
    ]);
    expect(await audit()).toEqual([
      {
        user_id: rootId,
        action: "USER_PERMISSIONS_SET",
        entity_type: "user",
        entity_id: qcId,
        before: { permissions: VIEWER },
        after: { permissions: { contracts: "VIEW", gate: "CREATE" } },
        at: clock.now(),
      },
    ]);

    // the same permissions again, in another order, are not a change
    expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: { gate: "CREATE", contracts: "VIEW" } })).statusCode).toBe(200);
    expect(await audit()).toHaveLength(1);
    // an empty object takes every permission away
    expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: {} })).json().user.permissions).toEqual({});
    expect(await audit()).toHaveLength(2);
    expect(await database.query("select count(*)::int as n from user_permissions where user_id = $1", [qcId])).toEqual([{ n: 0 }]);
  });

  it("answers 400 VALIDATION for an unknown module, a level the module does not have, or a module partners may not get", async () => {
    const { call, qcId, partnerUserId, audit, database } = await setup();
    const unknown = await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: { gate: "VIEW", nope: "VIEW", weighbridge: "VIEW" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      error: {
        code: "VALIDATION",
        message: "Data yang dikirim tidak valid.",
        fields: [
          { field: "permissions.nope", message: "Modul nope tidak ada." },
          // a module of a later phase cannot be granted yet
          { field: "permissions.weighbridge", message: "Modul weighbridge tidak ada." },
        ],
      },
    });
    const level = await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: { contracts: "CREATE", users: "CREATE" } });
    expect(level.json().error.fields).toEqual([
      { field: "permissions.contracts", message: "Tingkat CREATE tidak berlaku untuk modul contracts." },
      { field: "permissions.users", message: "Tingkat CREATE tidak berlaku untuk modul users." },
    ]);
    const partner = await call("PUT", `/api/admin/users/${partnerUserId}/permissions`, { permissions: { registrations: "CREATE", gate: "VIEW" } });
    expect(partner.statusCode).toBe(400);
    expect(partner.json().error.fields).toEqual([{ field: "permissions.gate", message: "Modul gate tidak bisa diberikan ke akun partner." }]);

    expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: { gate: "ADMIN" } })).statusCode).toBe(400);
    expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, { permissions: ["gate"] })).statusCode).toBe(400);
    expect((await call("PUT", `/api/admin/users/${qcId}/permissions`, {})).statusCode).toBe(400);
    expect((await call("PUT", "/api/admin/users/999999/permissions", { permissions: {} })).statusCode).toBe(404);
    expect((await call("PUT", "/api/admin/users/abc/permissions", { permissions: {} })).statusCode).toBe(400);
    expect(await audit()).toEqual([]);
    expect(await database.query("select count(*)::int as n from user_permissions where user_id = $1", [partnerUserId])).toEqual([{ n: 4 }]);
  });

  it("refuses with 409 LAST_ADMIN a change that leaves no active staff account with users:EDIT", async () => {
    const { app, call, rootId, database, audit } = await setup();
    const LAST_ADMIN = { error: { code: "LAST_ADMIN", message: "Harus ada sedikitnya satu akun internal aktif yang bisa mengatur hak akses." } };
    const own = await call("PUT", `/api/admin/users/${rootId}/permissions`, { permissions: { ...EVERYTHING, users: "VIEW" } });
    expect(own.statusCode).toBe(409);
    expect(own.json()).toEqual(LAST_ADMIN);
    expect((await call("PUT", `/api/admin/users/${rootId}/permissions`, { permissions: {} })).json()).toEqual(LAST_ADMIN);
    expect(await database.query("select level from user_permissions where user_id = $1 and module_code = 'users'", [rootId])).toEqual([{ level: "EDIT" }]);
    expect(await audit()).toEqual([]);

    // an inactive admin does not count; an active second admin does
    const other = await seedStaff(database, "other-admin", { users: "EDIT" });
    await database.query("update users set is_active = false where id = $1", [other]);
    expect((await call("PUT", `/api/admin/users/${rootId}/permissions`, { permissions: { gate: "EDIT" } })).statusCode).toBe(409);
    await database.query("update users set is_active = true where id = $1", [other]);
    expect((await call("PUT", `/api/admin/users/${rootId}/permissions`, { permissions: { gate: "EDIT" } })).statusCode).toBe(200);
    // the other admin cannot now take its own access away either
    const otherHeaders = await bearer(app, "other-admin");
    expect((await call("PUT", `/api/admin/users/${other}/permissions`, { permissions: {} }, otherHeaders)).json()).toEqual(LAST_ADMIN);
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
    const localId = await seedStaff(database, "Budi.Santoso@example.test", VIEWER);
    portal.ticket("ticket-1", portalUser());

    const response = await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "ticket-1", appId: "0f3a8e9c-2b4d-4c6e-8f10-123456789abc" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "budi.santoso@example.test#sso", permissions: {} });
    expect(response.json().user.id).not.toBe(localId);
    expect(await database.query("select username from users order by id")).toEqual([{ username: "Budi.Santoso@example.test" }, { username: "budi.santoso@example.test#sso" }]);

    // the next sign-in finds the same account again
    portal.ticket("ticket-2", portalUser());
    await app.inject({ method: "POST", url: "/api/auth/sso/exchange", payload: { token: "ticket-2", appId: "0f3a8e9c-2b4d-4c6e-8f10-123456789abc" } });
    expect(await database.query("select count(*)::int as n from users")).toEqual([{ n: 2 }]);
  });
});
