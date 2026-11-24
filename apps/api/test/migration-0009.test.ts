// 0009: the destinations master is switched off. A DO carries its destination as typed text since 0008, and the
// master has no page any more. The module disappears from the permission grid and from what an account holds; its
// routes refuse everyone, as the routes of a module of a later phase did before that phase switched it on. The
// table and old grants stay.
import { describe, expect, it } from "vitest";
import { freshDatabase, testApp } from "./helpers/app.js";
import { bearer, seedStaff } from "./helpers/users.js";

describe("migration 0009", () => {
  it("switches off the destinations module only, and keeps the table", async () => {
    const database = await freshDatabase();
    const rows = await database.query<{ code: string; is_active: boolean }>("select code, is_active from modules order by sort_order");
    expect(rows.filter((row) => !row.is_active).map((row) => row.code)).toEqual(["destinations"]);
    await database.query("insert into destinations (name, address) values ('Gudang Contoh', 'Jl. Contoh 1')");
    expect(await database.query("select count(*)::int as n from destinations")).toEqual([{ n: 1 }]);
  });
});

describe("the switched-off destinations module", () => {
  async function setup() {
    const context = await testApp();
    const { app, database } = context;
    const adminId = await seedStaff(database, "admin", { users: "EDIT", gate: "VIEW" });
    const holderId = await seedStaff(database, "holder", { gate: "VIEW" });
    const onlyId = await seedStaff(database, "only", { gate: "VIEW" });
    // grants made while the module was on stay in the table
    await database.query("insert into user_permissions (user_id, module_code, level) values ($1, 'destinations', 'EDIT'), ($2, 'destinations', 'EDIT')", [holderId, onlyId]);
    await database.query("delete from user_permissions where user_id = $1 and module_code = 'gate'", [onlyId]);
    const call = async (method: "GET" | "POST" | "PATCH" | "PUT", url: string, username: string, payload?: object) =>
      app.inject({ method, url, headers: await bearer(app, username), ...(payload ? { payload } : {}) });
    return { ...context, adminId, holderId, call };
  }

  it("is not listed among the modules nor in what an account holds", async () => {
    const { call, holderId, database } = await setup();
    const modules = (await call("GET", "/api/admin/modules", "admin")).json().items.map((item: { code: string }) => item.code);
    expect(modules).not.toContain("destinations");
    expect(modules).toHaveLength(20);
    expect((await call("GET", "/api/me", "holder")).json().user.permissions).toEqual({ gate: "VIEW" });
    const listed = (await call("GET", "/api/admin/users?q=holder", "admin")).json().items;
    expect(listed).toEqual([expect.objectContaining({ id: holderId, permissions: { gate: "VIEW" } })]);
    // it cannot be granted any more
    const granted = await call("PUT", `/api/admin/users/${holderId}/permissions`, "admin", { permissions: { gate: "VIEW", destinations: "VIEW" } });
    expect(granted.statusCode).toBe(400);
    expect(granted.json().error.fields).toEqual([{ field: "permissions.destinations", message: "Modul destinations tidak ada." }]);
    expect(await database.query("select level from user_permissions where user_id = $1 and module_code = 'destinations'", [holderId])).toEqual([{ level: "EDIT" }]);
  });

  it("refuses its routes to an account that still holds an old grant", async () => {
    const { call, database } = await setup();
    for (const [method, url, payload] of [
      ["GET", "/api/destinations", undefined],
      ["POST", "/api/destinations", { name: "Gudang Contoh", address: "Jl. Contoh 1" }],
      ["PATCH", "/api/destinations/1", { name: "Gudang Lain" }],
    ] as const) {
      const response = await call(method, url, "holder", payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
      // an account whose only grant is on this module holds nothing that counts
      expect((await call(method, url, "only", payload)).json().error.code).toBe("NO_ACCESS");
    }
    expect(await database.query("select count(*)::int as n from destinations")).toEqual([{ n: 0 }]);
  });
});
